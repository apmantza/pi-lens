import * as fs from "node:fs";
import mutableFs from "node:fs";
import fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	acquireBoundedPidFileLock,
	acquireQuarantinePidFileLock,
} from "../../clients/bounded-pid-file-lock.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

const testTimeoutScale = (() => {
	const parsed = Number(process.env.PI_LENS_TEST_TIMEOUT_SCALE ?? "1");
	return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
})();

const lockModuleUrl = pathToFileURL(
	path.resolve("clients/bounded-pid-file-lock.js"),
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
 * for `<name>.go`, then takes the lock (bounded or quarantine) with a wait of
 * `waitMs`. Inside, it writes `<name>.inside` and holds until `leave` exists,
 * then writes `<name>.left`; a writer that gives up writes `<name>.gaveup`.
 */
function spawnHolder(
	dir: string,
	lockPath: string,
	name: string,
	lock: "bounded" | "quarantine",
	waitMs = 20_000,
): ChildProcess {
	const file = (suffix: string) =>
		JSON.stringify(path.join(dir, `${name}.${suffix}`));
	const options = `{ waitMs: ${waitMs}, retryMs: 5, staleMs: 60000, timeoutMessage: "timed out", onContention: "skip-log", logContention: () => {} }`;
	const acquire =
		lock === "bounded"
			? `acquireBoundedPidFileLock(${JSON.stringify(lockPath)}, ${options})`
			: `await acquireQuarantinePidFileLock(${JSON.stringify(lockPath)}, ${options})`;
	const script = `
import fs from "node:fs";
const { acquireBoundedPidFileLock, acquireQuarantinePidFileLock } = await import(${JSON.stringify(lockModuleUrl)});
const pause = new Int32Array(new SharedArrayBuffer(4));
const waitFor = (file) => {
	const until = Date.now() + 20_000;
	while (!fs.existsSync(file) && Date.now() < until) Atomics.wait(pause, 0, 0, 5);
};
fs.writeFileSync(${file("ready")}, "");
waitFor(${file("go")});
const release = ${acquire};
if (!release) {
	fs.writeFileSync(${file("gaveup")}, "");
} else {
	fs.writeFileSync(${file("inside")}, String(process.pid));
	waitFor(${JSON.stringify(path.join(dir, "leave"))});
	fs.writeFileSync(${file("left")}, "");
	await release();
}
`;
	return spawn(process.execPath, ["--input-type=module", "-e", script], {
		cwd: process.cwd(),
		stdio: "ignore",
		windowsHide: true,
	});
}

/**
 * Run `during` inside the first liveness probe of each pid, then probe it.
 * Every stale judgement, of any lock layout, makes that probe:
 * `process.kill(pid, 0)`.
 */
function onLivenessProbes(during: ReadonlyMap<number, () => void>) {
	const fired = new Set<number>();
	const realKill = process.kill.bind(process);
	const spy = vi.spyOn(process, "kill").mockImplementation((probed, signal) => {
		const hook = during.get(Number(probed));
		if (hook && !fired.has(Number(probed))) {
			fired.add(Number(probed));
			hook();
		}
		return realKill(probed, signal);
	});
	return {
		fired: (pid: number) => fired.has(pid),
		restore: () => spy.mockRestore(),
	};
}

describe("pid-file locks: generation takeover (#3476)", () => {
	function tempLock(): { dir: string; lockPath: string } {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-pid-lock-"));
		tempDirs.push(dir);
		return { dir, lockPath: path.join(dir, "state.lock") };
	}

	// BoundedCrash.cfg on the real lock: p1 dies holding it; this process
	// (p3) judges it stale, and before p3 acts on that judgement p2 takes the
	// same lock over and enters. A takeover that removes the lock by path
	// then removes p2's live lock, and both are inside.
	it("bounded: admits one of two takers of a dead owner's lock", async () => {
		const { dir, lockPath } = tempLock();
		const p1 = spawnHolder(dir, lockPath, "p1", "bounded");
		const p1Exit = once(p1, "exit");
		const p2 = spawnHolder(dir, lockPath, "p2", "bounded");
		const p2Exit = once(p2, "exit");
		try {
			fs.writeFileSync(path.join(dir, "p1.go"), "");
			expect(waitForFileSync(path.join(dir, "p1.inside"))).toBe(true);
			p1.kill("SIGKILL");
			await p1Exit;
			expect(waitForFileSync(path.join(dir, "p2.ready"))).toBe(true);

			let p2Entered = false;
			const probe = onLivenessProbes(
				new Map([
					[
						p1.pid!,
						() => {
							fs.writeFileSync(path.join(dir, "p2.go"), "");
							p2Entered = waitForFileSync(path.join(dir, "p2.inside"));
						},
					],
				]),
			);
			let release: (() => void) | null;
			try {
				// p2 stays inside until `leave`, written only after this call.
				release = acquireBoundedPidFileLock(lockPath, {
					waitMs: 200,
					retryMs: 5,
					timeoutMessage: "p3 timed out",
					onContention: "skip-log",
					logContention: () => {},
				});
			} finally {
				probe.restore();
			}
			release?.();
			expect(p2Entered).toBe(true);
			expect(release).toBeNull();
		} finally {
			fs.writeFileSync(path.join(dir, "p2.go"), "");
			fs.writeFileSync(path.join(dir, "leave"), "");
			p1.kill("SIGKILL");
			await Promise.all([p1Exit, p2Exit]);
		}
	}, 30_000);

	// RegistryCrashFix4.cfg on the real quarantine lock: p1 dies holding it;
	// p3 (this process) judges it stale while p2 takes it over and enters.
	// p3's rename-aside-and-inspect then moves p2's live lock away, and while
	// it inspects, p4 finds the path empty and enters beside p2.
	it("quarantine: keeps a fourth writer out while a taker inspects a live successor", async () => {
		const { dir, lockPath } = tempLock();
		const p1 = spawnHolder(dir, lockPath, "p1", "quarantine");
		const p2 = spawnHolder(dir, lockPath, "p2", "quarantine");
		const p4 = spawnHolder(dir, lockPath, "p4", "quarantine", 300);
		const exits = [p1, p2, p4].map((child) => once(child, "exit"));
		try {
			fs.writeFileSync(path.join(dir, "p1.go"), "");
			expect(waitForFileSync(path.join(dir, "p1.inside"))).toBe(true);
			p1.kill("SIGKILL");
			await exits[0];
			expect(waitForFileSync(path.join(dir, "p2.ready"))).toBe(true);
			expect(waitForFileSync(path.join(dir, "p4.ready"))).toBe(true);

			let p2Entered = false;
			let p4EnteredBesideP2: boolean | undefined;
			const probe = onLivenessProbes(
				new Map([
					[
						p1.pid!,
						() => {
							fs.writeFileSync(path.join(dir, "p2.go"), "");
							p2Entered = waitForFileSync(path.join(dir, "p2.inside"));
						},
					],
					[
						p2.pid!,
						() => {
							fs.writeFileSync(path.join(dir, "p4.go"), "");
							const inside = path.join(dir, "p4.inside");
							const gaveUp = path.join(dir, "p4.gaveup");
							const pause = new Int32Array(new SharedArrayBuffer(4));
							const until = Date.now() + 10_000 * testTimeoutScale;
							while (!fs.existsSync(inside) && !fs.existsSync(gaveUp)) {
								if (Date.now() > until) break;
								Atomics.wait(pause, 0, 0, 5);
							}
							p4EnteredBesideP2 =
								fs.existsSync(inside) &&
								!fs.existsSync(path.join(dir, "p2.left"));
						},
					],
				]),
			);
			let release: (() => Promise<void>) | null;
			try {
				release = await acquireQuarantinePidFileLock(lockPath, {
					waitMs: 500,
					retryMs: 10,
					staleMs: 60_000,
					timeoutMessage: "p3 timed out",
					onContention: "skip-log",
					logContention: () => {},
				});
			} finally {
				probe.restore();
			}
			await release?.();
			expect(p2Entered).toBe(true);
			expect(probe.fired(p2.pid!)).toBe(true);
			expect(p4EnteredBesideP2).toBe(false);
			expect(release).toBeNull();
		} finally {
			for (const name of ["p2", "p4"])
				fs.writeFileSync(path.join(dir, `${name}.go`), "");
			fs.writeFileSync(path.join(dir, "leave"), "");
			p1.kill("SIGKILL");
			await Promise.all(exits);
		}
	}, 30_000);
});

describe("acquireBoundedPidFileLock", () => {
	it("defaults to throwing when contention policy is omitted", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-pid-lock-"));
		tempDirs.push(dir);
		const lockPath = path.join(dir, "state.lock");
		const releaseFirst = acquireBoundedPidFileLock(lockPath, {
			waitMs: 10,
			retryMs: 1,
			timeoutMessage: "first lock timed out",
		});
		expect(() =>
			acquireBoundedPidFileLock(lockPath, {
				waitMs: 0,
				retryMs: 1,
				timeoutMessage: "second lock timed out",
			}),
		).toThrow("second lock timed out");
		releaseFirst();
	});

	it("logs and skips after two seconds without disturbing a concurrent process's write", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-pid-lock-"));
		tempDirs.push(dir);
		const lockPath = path.join(dir, "state.lock");
		const statePath = path.join(dir, "state.json");
		const fixture = fileURLToPath(
			new URL("../fixtures/bounded-pid-lock-holder.mjs", import.meta.url),
		);
		const holder = spawn(process.execPath, [fixture, lockPath, statePath], {
			stdio: ["ignore", "pipe", "inherit"],
		});
		await new Promise<void>((resolve, reject) => {
			holder.once("error", reject);
			holder.stdout.once("data", (chunk) => {
				if (String(chunk).includes("locked")) resolve();
				else reject(new Error(`unexpected holder output: ${String(chunk)}`));
			});
		});
		const logContention = vi.fn();

		expect(
			acquireBoundedPidFileLock(lockPath, {
				waitMs: 2_000,
				retryMs: 10,
				timeoutMessage: "second lock timed out",
				onContention: "skip-log",
				logContention,
			}),
		).toBeNull();
		expect(logContention).toHaveBeenCalledOnce();
		await new Promise<void>((resolve, reject) => {
			holder.once("error", reject);
			holder.once("exit", (code) =>
				code === 0 ? resolve() : reject(new Error(`holder exited ${code}`)),
			);
		});
		expect(JSON.parse(fs.readFileSync(statePath, "utf8"))).toEqual({
			writer: "first",
		});
	});
});

describe("acquireBoundedPidFileLock with a lock whose pid is unreadable (#3475)", () => {
	// The lock is created by `openSync(lockPath, "wx")`, then the token is
	// written: a contender can read the file in between. An empty or garbled
	// lock parsed to NaN, which `ownerPidIsLive` reports as dead, so the
	// contender unlinked a live lock and both processes committed.
	function lockWith(content: string, ageMs: number): string {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-pid-lock-"));
		tempDirs.push(dir);
		const lockPath = path.join(dir, "state.lock");
		fs.writeFileSync(lockPath, content, "utf8");
		const at = new Date(Date.now() - ageMs);
		fs.utimesSync(lockPath, at, at);
		return lockPath;
	}

	function contend(lockPath: string) {
		const logContention = vi.fn();
		const release = acquireBoundedPidFileLock(lockPath, {
			waitMs: 50,
			retryMs: 5,
			timeoutMessage: "unreadable lock timed out",
			onContention: "skip-log",
			logContention,
		});
		return { release, logContention };
	}

	it.each([
		["empty", ""],
		["garbled", "not-a-pid"],
	])("waits on a fresh %s lock instead of unlinking it", (_label, content) => {
		const lockPath = lockWith(content, 0);
		const { release, logContention } = contend(lockPath);
		expect(release).toBeNull();
		expect(logContention).toHaveBeenCalledOnce();
		expect(fs.readFileSync(lockPath, "utf8")).toBe(content);
	});

	it.each([
		["empty", ""],
		["garbled", "not-a-pid"],
	])("reclaims a %s lock once it has aged out", (_label, content) => {
		const lockPath = lockWith(content, 10_000);
		const { release, logContention } = contend(lockPath);
		expect(typeof release).toBe("function");
		expect(logContention).not.toHaveBeenCalled();
		release?.();
		expect(fs.existsSync(lockPath)).toBe(false);
	});

	it("still reclaims a fresh lock whose token names a dead pid at once", async () => {
		const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
		const deadPid = child.pid as number;
		await new Promise<void>((resolve) => child.once("exit", () => resolve()));
		const lockPath = lockWith(`${deadPid}:${Date.now()}:gone`, 0);
		const { release, logContention } = contend(lockPath);
		expect(typeof release).toBe("function");
		expect(logContention).not.toHaveBeenCalled();
		release?.();
	});

	it("does not enter while a real process has opened the lock but not written its token", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-pid-lock-"));
		tempDirs.push(dir);
		const lockPath = path.join(dir, "state.lock");
		// The creator's first step, then a pause standing in for descheduling
		// before its token write, as acquireBoundedPidFileLock itself does.
		const creator = spawn(
			process.execPath,
			[
				"-e",
				`const fs = require("node:fs");
const fd = fs.openSync(process.argv[1], "wx");
process.stdout.write("opened\\n");
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);
fs.writeFileSync(fd, process.pid + ":" + Date.now() + ":creator", "utf8");
fs.closeSync(fd);
fs.unlinkSync(process.argv[1]);`,
				lockPath,
			],
			{ stdio: ["ignore", "pipe", "inherit"] },
		);
		const exited = new Promise<number | null>((resolve, reject) => {
			creator.once("error", reject);
			creator.once("exit", resolve);
		});
		await new Promise<void>((resolve, reject) => {
			creator.once("error", reject);
			creator.stdout.once("data", (chunk) => {
				if (String(chunk).includes("opened")) resolve();
				else reject(new Error(`unexpected creator output: ${String(chunk)}`));
			});
		});

		const { release } = contend(lockPath);
		expect(release).toBeNull();
		expect(await exited).toBe(0);
	});
});

describe("acquireBoundedPidFileLock across versions (#3476)", () => {
	function lockIn(): { lockPath: string; gens: string } {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-pid-lock-"));
		tempDirs.push(dir);
		const lockPath = path.join(dir, "state.lock");
		return { lockPath, gens: `${lockPath}s` };
	}

	function take(lockPath: string) {
		return acquireBoundedPidFileLock(lockPath, {
			waitMs: 0,
			retryMs: 5,
			timeoutMessage: "bounded lock timed out",
			onContention: "skip-log",
			logContention: () => {},
		});
	}

	function degradationCount(kind: string): number {
		return (
			getDegradationSummary().find((group) => group.kind === kind)?.count ?? 0
		);
	}

	afterEach(() => resetDegradationLedger());

	// A writer from before #3476 takes only `<store>.lock`, with `wx`.
	it("holds the pre-generation lock file while inside, so an older writer blocks", () => {
		const { lockPath } = lockIn();
		const release = take(lockPath);
		expect(release).toBeTypeOf("function");
		expect(() =>
			fs.writeFileSync(lockPath, "older writer", { flag: "wx" }),
		).toThrow(expect.objectContaining({ code: "EEXIST" }));
		expect(fs.readFileSync(lockPath, "utf8").split(":")[0]).toBe(
			String(process.pid),
		);
		release?.();
		expect(fs.existsSync(lockPath)).toBe(false);
	});

	it("backs off a live older writer's lock file without keeping its generation", () => {
		const { lockPath } = lockIn();
		fs.writeFileSync(lockPath, `${process.pid}:${Date.now()}:older`);
		expect(take(lockPath)).toBeNull();
		expect(degradationCount("generation-lock-legacy-held")).toBe(1);
		fs.unlinkSync(lockPath);
		// No wait: a generation kept by the back-off would hold this out.
		const release = take(lockPath);
		expect(release).toBeTypeOf("function");
		release?.();
	});

	it("keeps an older writer's replacement lock file when it releases", () => {
		const { lockPath } = lockIn();
		const release = take(lockPath);
		fs.writeFileSync(lockPath, "999999:0:older");
		release?.();
		expect(fs.readFileSync(lockPath, "utf8")).toBe("999999:0:older");
	});

	it("releases each generation and keeps only the two newest", () => {
		const { lockPath, gens } = lockIn();
		for (let round = 1; round <= 5; round++) {
			const release = take(lockPath);
			expect(release).toBeTypeOf("function");
			release?.();
		}
		expect(fs.readdirSync(gens).sort()).toEqual([
			"lock.4",
			"lock.4.released",
			"lock.5",
			"lock.5.released",
		]);
		expect(getDegradationSummary()).toEqual([]);
	});

	it("records a takeover of a dead owner's generation", async () => {
		const { lockPath, gens } = lockIn();
		const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
		await once(child, "exit");
		fs.mkdirSync(gens);
		fs.writeFileSync(path.join(gens, "lock.1"), `${child.pid} ${Date.now()}\n`);
		const release = take(lockPath);
		expect(release).toBeTypeOf("function");
		release?.();
		expect(degradationCount("generation-lock-stale-takeover")).toBe(1);
	});

	it("takes over a live owner's generation once the 5 s lease has run out", () => {
		const { lockPath, gens } = lockIn();
		fs.mkdirSync(gens);
		const lock = path.join(gens, "lock.1");
		fs.writeFileSync(lock, `${process.pid} ${Date.now()}\n`);
		const old = new Date(Date.now() - 10_000);
		fs.utimesSync(lock, old, old);
		const release = take(lockPath);
		expect(release).toBeTypeOf("function");
		release?.();
	});

	it("releases its generation when the old lock file cannot be created", () => {
		const { lockPath } = lockIn();
		const realWrite = mutableFs.writeFileSync;
		let refused = 0;
		mutableFs.writeFileSync = ((...args: Parameters<typeof realWrite>) => {
			if (args[0] === lockPath) {
				refused += 1;
				throw Object.assign(new Error("EACCES: permission denied"), {
					code: "EACCES",
				});
			}
			return realWrite(...args);
		}) as typeof realWrite;
		syncBuiltinESMExports();
		try {
			expect(() => take(lockPath)).toThrow("EACCES");
		} finally {
			mutableFs.writeFileSync = realWrite;
			syncBuiltinESMExports();
		}
		expect(refused).toBe(1);
		const release = take(lockPath);
		expect(release).toBeTypeOf("function");
		release?.();
	});
});

describe("acquireQuarantinePidFileLock across versions (#3476)", () => {
	function lockIn(): { lockPath: string; gens: string } {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-pid-lock-"));
		tempDirs.push(dir);
		const lockPath = path.join(dir, "state.lock");
		return { lockPath, gens: `${lockPath}s` };
	}

	function take(lockPath: string, staleMs = 60_000) {
		return acquireQuarantinePidFileLock(lockPath, {
			waitMs: 0,
			retryMs: 5,
			staleMs,
			timeoutMessage: "quarantine lock timed out",
			onContention: "skip-log",
			logContention: () => {},
		});
	}

	function degradationCount(kind: string): number {
		return (
			getDegradationSummary().find((group) => group.kind === kind)?.count ?? 0
		);
	}

	afterEach(() => resetDegradationLedger());

	// A writer from before #3476 takes only the `<store>.lock` directory.
	it("holds the pre-generation lock directory while inside, so an older writer blocks", async () => {
		const { lockPath } = lockIn();
		const release = await take(lockPath);
		expect(release).toBeTypeOf("function");
		expect(() => fs.mkdirSync(lockPath)).toThrow(
			expect.objectContaining({ code: "EEXIST" }),
		);
		const owner = JSON.parse(
			fs.readFileSync(path.join(lockPath, "owner.json"), "utf8"),
		);
		expect(owner.pid).toBe(process.pid);
		await release?.();
		expect(fs.existsSync(lockPath)).toBe(false);
	});

	it("backs off a live older writer's lock directory without keeping its generation", async () => {
		const { lockPath } = lockIn();
		fs.mkdirSync(lockPath);
		fs.writeFileSync(
			path.join(lockPath, "owner.json"),
			JSON.stringify({ pid: process.pid, createdAt: Date.now(), token: "old" }),
		);
		expect(await take(lockPath)).toBeNull();
		expect(degradationCount("generation-lock-legacy-held")).toBe(1);
		fs.rmSync(lockPath, { recursive: true });
		// No wait: a generation kept by the back-off would hold this out.
		const release = await take(lockPath);
		expect(release).toBeTypeOf("function");
		await release?.();
	});

	it("releases each generation and keeps only the two newest", async () => {
		const { lockPath, gens } = lockIn();
		for (let round = 1; round <= 5; round++) {
			const release = await take(lockPath);
			expect(release).toBeTypeOf("function");
			await release?.();
		}
		expect(fs.readdirSync(gens).sort()).toEqual([
			"lock.4",
			"lock.4.released",
			"lock.5",
			"lock.5.released",
		]);
		expect(getDegradationSummary()).toEqual([]);
	});

	it("records a takeover of a dead owner's generation", async () => {
		const { lockPath, gens } = lockIn();
		const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
		await once(child, "exit");
		fs.mkdirSync(gens);
		fs.writeFileSync(path.join(gens, "lock.1"), `${child.pid} ${Date.now()}\n`);
		const release = await take(lockPath);
		expect(release).toBeTypeOf("function");
		await release?.();
		expect(degradationCount("generation-lock-stale-takeover")).toBe(1);
	});

	it("takes over a live owner's generation once staleMs has run out", async () => {
		const { lockPath, gens } = lockIn();
		fs.mkdirSync(gens);
		const lock = path.join(gens, "lock.1");
		fs.writeFileSync(lock, `${process.pid} ${Date.now()}\n`);
		const old = new Date(Date.now() - 10_000);
		fs.utimesSync(lock, old, old);
		expect(await take(lockPath, 60_000)).toBeNull();
		const release = await take(lockPath, 5_000);
		expect(release).toBeTypeOf("function");
		await release?.();
	});

	it("releases its generation when the old lock directory cannot be created", async () => {
		const { lockPath } = lockIn();
		const realMkdir = fsp.mkdir;
		let refused = 0;
		fsp.mkdir = (async (...args: Parameters<typeof realMkdir>) => {
			if (args[0] === lockPath) {
				refused += 1;
				throw Object.assign(new Error("EACCES: permission denied"), {
					code: "EACCES",
				});
			}
			return realMkdir(...args);
		}) as typeof realMkdir;
		try {
			await expect(take(lockPath)).rejects.toThrow("EACCES");
		} finally {
			fsp.mkdir = realMkdir;
		}
		expect(refused).toBe(1);
		const release = await take(lockPath);
		expect(release).toBeTypeOf("function");
		await release?.();
	});
});
