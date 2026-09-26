import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	withInstanceRegistryLock,
	withInstanceRegistryLockSync,
} from "../../clients/instance-registry-lock.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import {
	tryAcquireGeneration,
	withGenerationLockSync,
} from "../../clients/generation-lock.js";
import { removeTempDirSync } from "./test-utils.js";

const dirs: string[] = [];

const testTimeoutScale = (() => {
	const parsed = Number(process.env.PI_LENS_TEST_TIMEOUT_SCALE ?? "1");
	return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
})();

afterEach(() => {
	for (const dir of dirs.splice(0)) removeTempDirSync(dir);
	// The #3476 cases time out by design; each case reads its own count.
	resetDegradationLedger();
});

function degradationKinds(): string[] {
	return getDegradationSummary().map((group) => group.kind);
}

const lockModuleUrl = pathToFileURL(
	path.resolve("clients/instance-registry-lock.js"),
).href;
const generationModuleUrl = pathToFileURL(
	path.resolve("clients/generation-lock.js"),
).href;

function waitForFileSync(file: string): boolean {
	const pause = new Int32Array(new SharedArrayBuffer(4));
	const until = Date.now() + 10_000 * testTimeoutScale;
	while (!fs.existsSync(file)) {
		if (Date.now() > until) return false;
		Atomics.wait(pause, 0, 0, 5);
	}
	return true;
}

/**
 * A real writer process: loads the lock module, writes `<name>.ready`, waits
 * for `<name>.go`, then holds the lock until `leave` exists. Inside, it
 * writes `<name>.inside`; on the way out, `<name>.left`. `generation` takes
 * the bare generation lock in the directory `target` instead of the
 * registry lock.
 */
function spawnHolder(
	dir: string,
	target: string,
	name: string,
	lock: "registry" | "generation" = "registry",
): ChildProcess {
	const file = (suffix: string) =>
		JSON.stringify(path.join(dir, `${name}.${suffix}`));
	const hold =
		lock === "registry"
			? `const { withInstanceRegistryLockSync } = await import(${JSON.stringify(lockModuleUrl)});
withInstanceRegistryLockSync(${JSON.stringify(target)}, inside);`
			: `const { tryAcquireGeneration } = await import(${JSON.stringify(generationModuleUrl)});
const until = Date.now() + 20_000;
while (!tryAcquireGeneration(${JSON.stringify(target)}, 5_000)) {
	if (Date.now() > until) process.exit(1);
	Atomics.wait(pause, 0, 0, 5);
}
inside();`;
	const script = `
import fs from "node:fs";
const pause = new Int32Array(new SharedArrayBuffer(4));
const waitFor = (file) => {
	const until = Date.now() + 20_000;
	while (!fs.existsSync(file) && Date.now() < until) Atomics.wait(pause, 0, 0, 5);
};
const inside = () => {
	fs.writeFileSync(${file("inside")}, String(process.pid));
	waitFor(${JSON.stringify(path.join(dir, "leave"))});
	fs.writeFileSync(${file("left")}, "");
};
fs.writeFileSync(${file("ready")}, "");
waitFor(${file("go")});
${hold}
`;
	return spawn(process.execPath, ["--input-type=module", "-e", script], {
		cwd: process.cwd(),
		stdio: "ignore",
		windowsHide: true,
	});
}

async function deadPid(): Promise<number> {
	const child = spawn(process.execPath, ["-e", ""], {
		stdio: "ignore",
		windowsHide: true,
	});
	await once(child, "exit");
	return child.pid!;
}

/** Run `during` inside the first liveness probe of `pid`, then probe it. */
function onLivenessProbe(pid: number, during: () => void) {
	let fired = false;
	const realKill = process.kill.bind(process);
	const spy = vi.spyOn(process, "kill").mockImplementation((probed, signal) => {
		if (probed === pid && !fired) {
			fired = true;
			during();
		}
		return realKill(probed, signal);
	});
	return {
		fired: () => fired,
		restore: () => spy.mockRestore(),
	};
}

const variants = [
	{
		name: "sync",
		enter: async (target: string) =>
			withInstanceRegistryLockSync(target, () => "entered"),
	},
	{
		name: "async",
		enter: (target: string) =>
			withInstanceRegistryLock(target, async () => "entered"),
	},
];

describe("instance registry lock: generation takeover (#3476)", () => {
	function tempTarget(): { dir: string; target: string; gens: string } {
		const dir = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-registry-lock-"),
		);
		dirs.push(dir);
		const target = path.join(dir, "instances.json");
		return { dir, target, gens: `${target}.locks` };
	}

	// RegistryCrash.cfg's counterexample (formal/file-locks/
	// repro-registry-double-takeover.mjs) on the real lock: p1 dies holding
	// the lock; this process (p3) judges it stale, and before p3 acts on that
	// judgement p2 takes the same lock over and enters. A takeover that
	// removes the lock by path then removes p2's live lock, and both are
	// inside. The seam is the liveness probe every stale judgement makes,
	// `process.kill(deadPid, 0)`, so the test holds for any lock layout.
	it.each(variants)(
		"admits one of two takers of a dead owner's lock ($name)",
		async ({ enter }) => {
			const { dir, target } = tempTarget();
			const p1 = spawnHolder(dir, target, "p1");
			const p1Exit = once(p1, "exit");
			const p2 = spawnHolder(dir, target, "p2");
			const p2Exit = once(p2, "exit");
			try {
				fs.writeFileSync(path.join(dir, "p1.go"), "");
				expect(waitForFileSync(path.join(dir, "p1.inside"))).toBe(true);
				p1.kill("SIGKILL");
				await p1Exit;
				expect(waitForFileSync(path.join(dir, "p2.ready"))).toBe(true);

				let p2Entered = false;
				const probe = onLivenessProbe(p1.pid!, () => {
					fs.writeFileSync(path.join(dir, "p2.go"), "");
					p2Entered = waitForFileSync(path.join(dir, "p2.inside"));
				});
				let result: string | undefined;
				try {
					// p2 stays inside until `leave`, written only after this call.
					result = await enter(target);
				} finally {
					probe.restore();
				}
				expect(p2Entered).toBe(true);
				expect(result).toBeUndefined();
			} finally {
				fs.writeFileSync(path.join(dir, "p2.go"), "");
				fs.writeFileSync(path.join(dir, "leave"), "");
				p1.kill("SIGKILL");
				await Promise.all([p1Exit, p2Exit]);
			}
		},
	);

	// The same race on the bare generation lock, without the registry's
	// pre-generation lock file (which would block p3 on its own): both takers
	// judged lock.1's owner dead, and only one create of lock.2 may succeed.
	it("lets one exclusive create win a dead owner's generation", async () => {
		const { dir, gens } = tempTarget();
		const dead = await deadPid();
		fs.mkdirSync(gens);
		fs.writeFileSync(path.join(gens, "lock.1"), `${dead} ${Date.now()}\n`);
		const p2 = spawnHolder(dir, gens, "p2", "generation");
		const p2Exit = once(p2, "exit");
		try {
			expect(waitForFileSync(path.join(dir, "p2.ready"))).toBe(true);
			let p2Entered = false;
			const probe = onLivenessProbe(dead, () => {
				fs.writeFileSync(path.join(dir, "p2.go"), "");
				p2Entered = waitForFileSync(path.join(dir, "p2.inside"));
			});
			let hold: ReturnType<typeof tryAcquireGeneration>;
			try {
				hold = tryAcquireGeneration(gens, 5_000);
			} finally {
				probe.restore();
			}
			expect(p2Entered).toBe(true);
			expect(hold).toBeUndefined();
		} finally {
			fs.writeFileSync(path.join(dir, "p2.go"), "");
			fs.writeFileSync(path.join(dir, "leave"), "");
			await p2Exit;
		}
	});

	// GenerationNoRecheck.cfg on the real lock: this process lists lock.1
	// (dead owner) as the top; before it creates lock.2, others take lock.2,
	// lock.3 and lock.4, and lock.4's holder cleans up below its predecessor,
	// removing lock.2. The stale listing's create of lock.2 then succeeds, and
	// only the post-create listing sees lock.4 still held.
	it("backs off a generation created from a stale listing", async () => {
		const { target, gens } = tempTarget();
		const dead = await deadPid();
		fs.mkdirSync(gens);
		fs.writeFileSync(path.join(gens, "lock.1"), `${dead} ${Date.now()}\n`);
		const probe = onLivenessProbe(dead, () => {
			fs.writeFileSync(path.join(gens, "lock.3"), `${dead} ${Date.now()}\n`);
			fs.writeFileSync(path.join(gens, "lock.3.released"), "");
			fs.writeFileSync(
				path.join(gens, "lock.4"),
				`${process.pid} ${Date.now()}\n`,
			);
			fs.unlinkSync(path.join(gens, "lock.1"));
		});
		let result: string | undefined;
		try {
			result = withInstanceRegistryLockSync(target, () => "entered");
		} finally {
			probe.restore();
		}
		expect(probe.fired()).toBe(true);
		expect(result).toBeUndefined();
		expect(fs.existsSync(path.join(gens, "lock.2.released"))).toBe(true);
	});

	it("releases each generation and keeps only the two newest", () => {
		const { target, gens } = tempTarget();
		for (let round = 1; round <= 10; round++) {
			expect(withInstanceRegistryLockSync(target, () => round)).toBe(round);
		}
		expect(fs.readdirSync(gens).sort()).toEqual([
			"lock.10",
			"lock.10.released",
			"lock.9",
			"lock.9.released",
		]);
		expect(fs.existsSync(`${target}.lock`)).toBe(false);
		// A released predecessor is no takeover, and nothing held the old file.
		expect(degradationKinds()).toEqual([]);
	});

	it("records a takeover of a dead owner's generation", () => {
		const { target, gens } = tempTarget();
		fs.mkdirSync(gens);
		fs.writeFileSync(
			path.join(gens, "lock.1"),
			`999999 ${Date.now() - 10_000}\n`,
		);
		const old = new Date(Date.now() - 10_000);
		fs.utimesSync(path.join(gens, "lock.1"), old, old);
		expect(withInstanceRegistryLockSync(target, () => "entered")).toBe(
			"entered",
		);
		expect(getDegradationSummary()).toContainEqual(
			expect.objectContaining({
				kind: "instance-registry-lock-stale-takeover",
				count: 1,
			}),
		);
	});

	// Mixed versions: a writer from before #3476 takes only `<target>.lock`.
	it("holds the pre-generation lock file while inside, so an older writer blocks", () => {
		const { target } = tempTarget();
		const legacy = `${target}.lock`;
		expect(
			withInstanceRegistryLockSync(target, () => {
				expect(() =>
					fs.writeFileSync(legacy, "older writer\n", { flag: "wx" }),
				).toThrow(expect.objectContaining({ code: "EEXIST" }));
				return fs.readFileSync(legacy, "utf8").split(" ")[0];
			}),
		).toBe(String(process.pid));
		expect(fs.existsSync(legacy)).toBe(false);
	});

	it("waits for a live older writer's lock file, then acquires once it goes", () => {
		const { target } = tempTarget();
		const legacy = `${target}.lock`;
		fs.writeFileSync(legacy, `${process.pid} ${Date.now()}\n`);
		expect(
			withInstanceRegistryLockSync(target, () => "entered"),
		).toBeUndefined();
		expect(degradationKinds()).toContain("instance-registry-lock-legacy-held");
		fs.unlinkSync(legacy);
		expect(withInstanceRegistryLockSync(target, () => "entered")).toBe(
			"entered",
		);
	});

	// #3476 review F1: a lock directory this process cannot use (here a file
	// in its place; in the field a root-owned directory left by `sudo pi`)
	// must not throw into session shutdown's deregisterInstance().
	it("degrades instead of throwing when the lock directory is unusable", async () => {
		const { target, gens } = tempTarget();
		fs.writeFileSync(gens, "not a directory\n");
		expect(
			withInstanceRegistryLockSync(target, () => "entered"),
		).toBeUndefined();
		await expect(
			withInstanceRegistryLock(target, async () => "entered"),
		).resolves.toBeUndefined();
		expect(getDegradationSummary()).toContainEqual(
			expect.objectContaining({
				kind: "instance-registry-lock-failed",
				count: 2,
			}),
		);
	});

	// #3476 review F2: a listing that throws after the create must not leave
	// this process's live generation holding everyone out for the lease.
	it("releases a created generation when the listing after it throws", () => {
		const { target } = tempTarget();
		const realReaddir = fs.readdirSync;
		let listings = 0;
		fs.readdirSync = ((...args: Parameters<typeof realReaddir>) => {
			listings += 1;
			if (listings === 2)
				throw Object.assign(new Error("EMFILE: too many open files"), {
					code: "EMFILE",
				});
			return realReaddir(...args);
		}) as typeof fs.readdirSync;
		syncBuiltinESMExports();
		let first: string | undefined;
		try {
			first = withInstanceRegistryLockSync(target, () => "entered");
		} finally {
			fs.readdirSync = realReaddir;
			syncBuiltinESMExports();
		}
		expect(listings).toBe(2);
		expect(first).toBeUndefined();
		expect(withInstanceRegistryLockSync(target, () => "entered")).toBe(
			"entered",
		);
	});

	it("releases its generation when the old lock file cannot be created", () => {
		const { target } = tempTarget();
		const realWrite = fs.writeFileSync;
		let refused = 0;
		fs.writeFileSync = ((...args: Parameters<typeof realWrite>) => {
			if (args[0] === `${target}.lock`) {
				refused += 1;
				throw Object.assign(new Error("EACCES: permission denied"), {
					code: "EACCES",
				});
			}
			return realWrite(...args);
		}) as typeof fs.writeFileSync;
		syncBuiltinESMExports();
		let first: string | undefined;
		try {
			first = withInstanceRegistryLockSync(target, () => "entered");
		} finally {
			fs.writeFileSync = realWrite;
			syncBuiltinESMExports();
		}
		expect(refused).toBe(1);
		expect(first).toBeUndefined();
		expect(withInstanceRegistryLockSync(target, () => "entered")).toBe(
			"entered",
		);
	});

	// #3476 review F4: before #3476 the sync variant's catch wrapped the op,
	// so an op error coded like contention was swallowed and the op re-ran.
	it("propagates an op error coded like contention once", () => {
		const { target } = tempTarget();
		let runs = 0;
		expect(() =>
			withInstanceRegistryLockSync(target, () => {
				runs += 1;
				throw Object.assign(new Error("op failed"), { code: "EEXIST" });
			}),
		).toThrow("op failed");
		expect(runs).toBe(1);
	});
});

describe("instance registry lock", () => {
	it("takes over an old lock owned by a dead pid", async () => {
		const dir = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-registry-lock-"),
		);
		dirs.push(dir);
		const target = path.join(dir, "instances.json");
		const lock = `${target}.lock`;
		fs.writeFileSync(lock, "999999 0\n");
		const old = new Date(Date.now() - 10_000);
		fs.utimesSync(lock, old, old);

		await expect(
			withInstanceRegistryLock(target, async () => "acquired"),
		).resolves.toBe("acquired");
		expect(fs.existsSync(lock)).toBe(false);
	});

	it("records one bounded degradation when contention exhausts the wait", async () => {
		const dir = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-registry-lock-"),
		);
		dirs.push(dir);
		const target = path.join(dir, "instances.json");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(`${target}.lock`, `${process.pid} ${Date.now()}\n`);

		await expect(
			withInstanceRegistryLock(target, async () => "not reached"),
		).resolves.toBeUndefined();
		await expect(
			withInstanceRegistryLock(target, async () => "not reached"),
		).resolves.toBeUndefined();
		expect(getDegradationSummary()).toContainEqual(
			expect.objectContaining({
				kind: "instance-registry-lock-timeout",
				count: 2,
				latestReasons: [
					expect.objectContaining({ subject: path.resolve(target) }),
				],
			}),
		);
		fs.unlinkSync(`${target}.lock`);
	});

	it("does not reclaim a fresh empty lock", async () => {
		const dir = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-registry-lock-"),
		);
		dirs.push(dir);
		const target = path.join(dir, "instances.json");
		fs.writeFileSync(`${target}.lock`, "");

		await expect(
			withInstanceRegistryLock(target, async () => "not reached"),
		).resolves.toBeUndefined();
		expect(fs.existsSync(`${target}.lock`)).toBe(true);
		fs.unlinkSync(`${target}.lock`);
	});

	it("keeps a replacement lock when the displaced holder releases", () => {
		const dir = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-registry-lock-"),
		);
		dirs.push(dir);
		const target = path.join(dir, "instances.json");
		const lock = `${target}.lock`;

		expect(
			withInstanceRegistryLockSync(target, () => {
				fs.writeFileSync(lock, "999999 0\n");
				return "acquired";
			}),
		).toBe("acquired");
		expect(fs.readFileSync(lock, "utf8")).toBe("999999 0\n");
		fs.unlinkSync(lock);
	});

	it("excludes async acquisition while the sync path owns the lock", async () => {
		const dir = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-registry-lock-"),
		);
		dirs.push(dir);
		const target = path.join(dir, "instances.json");
		let contender: Promise<string | undefined> | undefined;

		expect(
			withInstanceRegistryLockSync(target, () => {
				contender = withInstanceRegistryLock(target, async () => "async");
				const end = Date.now() + 50;
				while (Date.now() < end) {}
				return "sync";
			}),
		).toBe("sync");
		expect(contender).toBeDefined();
		expect(await contender!).toBe("async");
	});

	it("holds the lock against a child-process contender during the sync body", () => {
		const dir = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-registry-lock-"),
		);
		dirs.push(dir);
		const target = path.join(dir, "instances.json");
		const marker = path.join(dir, "sync-body.marker");
		const lockModule = pathToFileURL(
			path.resolve("clients/instance-registry-lock.js"),
		).href;
		const childScript = `import(${JSON.stringify(lockModule)}).then(({ withInstanceRegistryLockSync }) => { const result = withInstanceRegistryLockSync(process.argv[1], () => "acquired"); process.stdout.write(result === undefined ? "blocked" : result); });`;

		expect(
			withInstanceRegistryLockSync(target, () => {
				fs.writeFileSync(marker, "sync body reached\n");
				return execFileSync(
					process.execPath,
					["--input-type=module", "-e", childScript, target],
					{
						encoding: "utf8",
						cwd: process.cwd(),
						timeout: 2_000 * testTimeoutScale,
						windowsHide: true,
					},
				).trim();
			}),
		).toBe("blocked");
		expect(fs.readFileSync(marker, "utf8")).toBe("sync body reached\n");
	});
});

describe("withGenerationLockSync (#3509)", () => {
	function lockDir(): string {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-gen-sync-"));
		dirs.push(dir);
		return path.join(dir, "cache.locks");
	}

	it("waits out a sibling's short hold and then runs op once", () => {
		const dir = lockDir();
		// A sibling won the exclusive create twice: this process backs off and
		// retries inside its wait instead of giving the save up.
		const realWrite = fs.writeFileSync;
		let contended = 0;
		fs.writeFileSync = ((...args: Parameters<typeof realWrite>) => {
			const file = String(args[0]);
			if (contended < 2 && /[\\/]lock\.\d+$/.test(file)) {
				contended += 1;
				throw Object.assign(new Error("EEXIST: file already exists"), {
					code: "EEXIST",
				});
			}
			return realWrite(...args);
		}) as typeof fs.writeFileSync;
		syncBuiltinESMExports();
		let ran = 0;
		let result: ReturnType<typeof withGenerationLockSync<string>>;
		try {
			result = withGenerationLockSync(
				dir,
				{ staleMs: 5_000, waitMs: 500 },
				() => {
					ran += 1;
					return "entered";
				},
			);
		} finally {
			fs.writeFileSync = realWrite;
			syncBuiltinESMExports();
		}
		expect(contended).toBe(2);
		expect(ran).toBe(1);
		expect(result).toEqual({ held: true, value: "entered" });
	});

	it("stops on a filesystem error other than contention and hands back its cause", () => {
		const dir = lockDir();
		const realMkdir = fs.mkdirSync;
		fs.mkdirSync = ((...args: Parameters<typeof realMkdir>) => {
			if (String(args[0]) === dir) {
				throw Object.assign(new Error("EACCES: permission denied"), {
					code: "EACCES",
				});
			}
			return realMkdir(...args);
		}) as typeof fs.mkdirSync;
		syncBuiltinESMExports();
		let ran = 0;
		let result: ReturnType<typeof withGenerationLockSync<string>>;
		try {
			result = withGenerationLockSync(
				dir,
				{ staleMs: 5_000, waitMs: 500 },
				() => {
					ran += 1;
					return "entered";
				},
			);
		} finally {
			fs.mkdirSync = realMkdir;
			syncBuiltinESMExports();
		}
		expect(ran).toBe(0);
		expect(result).toEqual({
			held: false,
			cause: expect.objectContaining({ code: "EACCES" }),
		});
	});
});
