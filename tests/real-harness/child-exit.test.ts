import { spawn, type ChildProcess } from "node:child_process";
import nodeFs, {
	existsSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	removeTempDirSync,
	setupTestEnvironment,
} from "../clients/test-utils.js";
import {
	adoptProcessTree,
	killGuardReport,
	takeKillGuardViolationsForTest,
} from "../support/kill-guard.js";
import { waitFor } from "../clients/interleaving-kit.js";
import { getProcessSingleton } from "../../clients/process-singletons.js";
import { safeSpawnAsync } from "../../clients/safe-spawn.js";
import { isProcessAlive, killProcessTree } from "../support/process-tree.js";
import { waitForChildExit, withRealPi } from "../support/real-pi-harness.js";

// The one real spawn site of this file's helper-free children.
const spawnNode = (script: string, ...args: string[]): ChildProcess =>
	spawn(process.execPath, ["-e", script, ...args], {
		stdio: ["ignore", "pipe", "ignore"],
	});
const exited = (child: ChildProcess) =>
	new Promise<void>((resolve) => {
		if (child.exitCode !== null || child.signalCode !== null) resolve();
		else child.once("exit", () => resolve());
	});

// Writes new files into argv[1] back to back for argv[2] ms, then exits: the
// shape of a process still writing under a directory being removed. Tight on
// purpose: a gap between files lets one rmSync pass win the race.
const WRITER = `
const fs = require("fs"), p = require("path");
const dir = process.argv[1], end = Date.now() + Number(process.argv[2]);
// 2000 names, rewritten in a cycle: enough files that one removal pass
// outlasts a few writes (a near-empty directory can be removed between two of
// them, which is not the race), and bounded on disk however long it runs.
for (let i = 0; i < 2000; i++) fs.writeFileSync(p.join(dir, "f" + i), "x");
console.log("ready");
for (let i = 0; Date.now() < end; i++) {
  try { fs.writeFileSync(p.join(dir, "f" + (i % 2000)), "x"); } catch {}
}`;

// Creates argv[1] and writes into it every 2 ms until it is killed: the
// reparented grandchild the real pi leaves behind (knip, ast-grep, tsserver).
// It exits by itself after 30 s: when close() fails to reap it, the test must
// not signal a pid the kill-guard no longer sees as this worker's (#2042).
const ORPHAN_WRITER = `
const fs = require("fs");
setTimeout(() => process.exit(0), 30000);
fs.mkdirSync(process.argv[1], { recursive: true });
let i = 0;
setInterval(() => {
  try { fs.writeFileSync(process.argv[1] + "/f" + (i++ % 500), "x"); } catch {}
}, 2);`;

// flake-shape: real-process-spawn — child death is only observable at the real process boundary
describe("real pi harness: child lifecycle", () => {
	const stray: ChildProcess[] = [];
	afterEach(() => {
		for (const child of stray.splice(0)) child.kill("SIGKILL");
		vi.restoreAllMocks();
	});

	it("waits for a real child to report exit before teardown continues", async () => {
		const child = spawnNode("setTimeout(() => {}, 100)");
		await waitForChildExit(child);
		expect(child.exitCode).toBe(0);
	});

	// Recurrence: teardown that hangs forever on a child that never reports
	// exit. A SIGSTOPped real child cannot exit until it is SIGKILLed.
	it("gives up on a child that never exits after the bound, with one diagnostic", async () => {
		const write = vi
			.spyOn(process.stderr, "write")
			.mockImplementation(() => true);
		const child = spawnNode("setInterval(() => {}, 1000)");
		stray.push(child);
		child.kill("SIGSTOP");
		await waitForChildExit(child, [], 50);
		expect(child.exitCode).toBeNull();
		expect(write.mock.calls.map(([line]) => String(line))).toEqual([
			"[real-pi cleanup] child tree did not exit within 50ms\n",
		]);
	}, 15_000);

	// Recurrence: a killed process nobody has reaped yet still answers
	// `kill(pid, 0)`. Waiting on that would stall teardown for the whole bound
	// whenever a reparented grandchild's new parent reaps slowly. The child's
	// zombie persists until this worker's event loop turns, which the
	// synchronous pause below never lets it do.
	it.skipIf(process.platform !== "linux")(
		"does not count a killed, unreaped process as alive",
		() => {
			const child = spawnNode("setInterval(() => {}, 1000)");
			stray.push(child);
			const pid = child.pid as number;
			child.kill("SIGKILL");
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
			expect(() => process.kill(pid, 0)).not.toThrow();
			expect(isProcessAlive(pid)).toBe(false);
		},
	);

	// Recurrence (#4082 r3, a false survivor in a real-harness lane run): a
	// reparented process being reaped answers `kill(pid, 0)`, then shows state
	// X, then has no `/proc` entry; both later reads said "alive" after an
	// earlier poll had seen it dead (176 of 200 runs on round 2's code).
	it.skipIf(process.platform !== "linux")(
		"never reads a killed process as alive again once a poll saw it dead",
		async () => {
			let flips = 0;
			for (let run = 0; run < 50; run++) {
				const root = spawnNode(`${ORPHAN}\nsetInterval(() => {}, 1000);`, "5");
				stray.push(root);
				const pid = Number(await firstLine(root));
				killProcessTree(root);
				let seenDead = false;
				// Synchronous on purpose: `pid` is reaped by its new parent, not
				// by this worker's event loop, so nothing here needs to turn.
				const end = Date.now() + 1_000;
				while (Date.now() < end) {
					if (!isProcessAlive(pid)) seenDead = true;
					else if (seenDead) {
						flips++;
						break;
					}
					try {
						process.kill(pid, 0);
					} catch {
						break;
					}
				}
				await exited(root);
			}
			expect(flips).toBe(0);
		},
		60_000,
	);

	// Recurrence (#4081): pi exits but its reparented grandchild keeps writing
	// under the scratch home; the wait must cover pids beyond the direct child.
	it("also waits for the listed descendants, and gives up on one that stays", async () => {
		const write = vi
			.spyOn(process.stderr, "write")
			.mockImplementation(() => true);
		const done = spawnNode("");
		const lingering = spawnNode("setInterval(() => {}, 1000)");
		stray.push(lingering);
		await exited(done);
		await waitForChildExit(done, [lingering.pid as number], 50);
		expect(write).toHaveBeenCalledTimes(1);
		lingering.kill("SIGKILL");
		await exited(lingering);
		await waitForChildExit(done, [lingering.pid as number], 50);
		expect(write).toHaveBeenCalledTimes(1);
	}, 15_000);

	// Recurrence (#4081): withRealPi's close() killed only the direct child. The
	// real pi's grandchildren are detached (their own process group), outlive
	// it, and keep writing under the scratch home, so the recursive removal
	// threw ENOTEMPTY. This drives the real pi with an extra extension that
	// spawns exactly that shape, and asserts on what close() leaves behind.
	it.skipIf(process.platform === "win32")(
		"close() kills pi and its detached descendants and removes the home they write into",
		async () => {
			const { tmpDir, cleanup } = setupTestEnvironment(
				"pi-lens-orphan-writer-",
			);
			const info = path.join(tmpDir, "info.json");
			const extension = path.join(tmpDir, "orphan-writer.mjs");
			writeFileSync(
				extension,
				`import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
export default function () {
  const writer = spawn(process.execPath, ["-e", ${JSON.stringify(ORPHAN_WRITER)}, process.env.HOME + "/orphan"], { detached: true, stdio: "ignore" });
  writer.unref();
  writeFileSync(process.env.ORPHAN_WRITER_INFO, JSON.stringify({ pi: process.pid, writer: writer.pid, home: process.env.HOME }));
}
`,
			);
			let pi = 0;
			let writer = 0;
			let home = "";
			try {
				await withRealPi(
					{
						fixture: "scenario-1",
						script: "script.json",
						args: ["-e", extension],
						env: { ORPHAN_WRITER_INFO: info },
					},
					async () => {
						({ pi, writer, home } = JSON.parse(readFileSync(info, "utf8")) as {
							pi: number;
							writer: number;
							home: string;
						});
						expect(isProcessAlive(writer)).toBe(true);
					},
				);
				// close() has returned: the child is reaped (only the exit event
				// reaps it), the detached writer is gone, and its home is removed.
				expect(() => process.kill(pi, 0)).toThrow(/ESRCH/);
				expect(isProcessAlive(writer)).toBe(false);
				expect(existsSync(home)).toBe(false);
			} finally {
				cleanup();
			}
		},
		60_000,
	);

	// PATH is emptied so the child can start only through the harness's own
	// PATH head (#3742); a bare `pi` lookup would exit before the kill.
	it("rejects a governed wait immediately when pi is killed", async () => {
		await withRealPi(
			{ fixture: "scenario-1", script: "script.json", env: { PATH: "" } },
			async (pi) => {
				await pi.prompt("start a turn");
				const started = Date.now();
				const pending = pi.awaitToolResult("never-produced");
				pi.killChildForTest();
				await expect(pending).rejects.toMatchObject({
					name: "RealPiChildExitError",
					signal: "SIGKILL",
				});
				expect(Date.now() - started).toBeLessThan(2_000);
			},
		);
	}, 60_000);
});

describe("removeTempDirSync under a live writer", () => {
	const stray: ChildProcess[] = [];
	afterEach(() => {
		for (const child of stray.splice(0)) child.kill("SIGKILL");
		vi.restoreAllMocks();
	});
	async function startWriter(dir: string, ms: number): Promise<void> {
		const child = spawnNode(WRITER, dir, String(ms));
		stray.push(child);
		await new Promise((resolve) => child.stdout?.once("data", resolve));
	}

	// Recurrence (#4081): one rmSync call (Node 22's in-call maxRetries stalls
	// ~3 s and still throws ENOTEMPTY) leaves the directory behind while a
	// writer is still adding files; fresh calls re-walk it and succeed once the
	// writer is done.
	it("removes a directory a live writer stops writing to partway through", async () => {
		const write = vi
			.spyOn(process.stderr, "write")
			.mockImplementation(() => true);
		const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-rm-writer-");
		await startWriter(tmpDir, 400);
		removeTempDirSync(tmpDir);
		expect(existsSync(tmpDir)).toBe(false);
		expect(write).not.toHaveBeenCalled();
		cleanup();
	}, 15_000);

	// Recurrence (#4349): the give-up path was driven by a real writer that had
	// to outlive the budget, so a starved writer let the first rmSync pass win
	// and the one-diagnostic assertion failed on CI (master run 38144066641,
	// PR #4341 run 115473062346). The directory's removal is made to fail the
	// way a busy directory does, so the path is reached on every run.
	const RUNAWAY_PASSES = 150;
	const restoreFs: Array<() => void> = [];
	afterEach(() => {
		for (const restore of restoreFs.splice(0)) restore();
	});
	/** Make the first `failures` rmSync passes over `dir` throw `code`; return the pass count. */
	function failRemoval(
		dir: string,
		code: string,
		failures: number,
	): () => number {
		const real = nodeFs.rmSync;
		let passes = 0;
		nodeFs.rmSync = ((target, options) => {
			if (target !== dir) return real(target, options);
			// A removal loop that lost its deadline retries for ever and hangs the
			// worker (exit 124). A pass far past the expected ~40 throws an error
			// with no retryable code, so the loop ends and the pass-count
			// assertion below fails by name instead.
			if (++passes > RUNAWAY_PASSES)
				throw new Error(
					`runaway removal loop: pass ${passes} past the 2 s budget`,
				);
			if (passes <= failures)
				throw Object.assign(new Error(`${code}: directory busy`), { code });
			return real(target, options);
		}) as typeof nodeFs.rmSync;
		syncBuiltinESMExports();
		restoreFs.push(() => {
			nodeFs.rmSync = real;
			syncBuiltinESMExports();
		});
		return () => passes;
	}
	function dirWithFile(): { tmpDir: string; cleanup: () => void } {
		const env = setupTestEnvironment("pi-lens-rm-giveup-");
		writeFileSync(path.join(env.tmpDir, "f"), "x");
		return env;
	}

	it("gives up once, bounded and without throwing, when every removal pass fails", () => {
		const write = vi
			.spyOn(process.stderr, "write")
			.mockImplementation(() => true);
		const { tmpDir, cleanup } = dirWithFile();
		const passes = failRemoval(tmpDir, "ENOTEMPTY", Infinity);
		expect(() => removeTempDirSync(tmpDir)).not.toThrow();
		// Retried (not one-shot) and bounded: a 2 s budget at a 50 ms retry is
		// about 40 passes, and 100 leaves room for a run that is not slow.
		expect(passes()).toBeGreaterThan(1);
		expect(
			passes(),
			"removeTempDirSync kept retrying past its 2 s budget (deadline guard regressed)",
		).toBeLessThan(100);
		expect(existsSync(tmpDir)).toBe(true);
		expect(write).toHaveBeenCalledTimes(1);
		expect(String(write.mock.calls[0]?.[0])).toContain(
			`[test cleanup] could not remove temp dir ${tmpDir}`,
		);
		restoreFs.splice(0).forEach((restore) => restore());
		write.mockClear();
		cleanup();
		expect(existsSync(tmpDir)).toBe(false);
		expect(write).not.toHaveBeenCalled();
	}, 15_000);

	it("gives up at once on an error that is not transient", () => {
		const write = vi
			.spyOn(process.stderr, "write")
			.mockImplementation(() => true);
		const { tmpDir, cleanup } = dirWithFile();
		const passes = failRemoval(tmpDir, "EACCES", Infinity);
		expect(() => removeTempDirSync(tmpDir)).not.toThrow();
		expect(passes()).toBe(1);
		expect(write).toHaveBeenCalledTimes(1);
		restoreFs.splice(0).forEach((restore) => restore());
		write.mockClear();
		cleanup();
	});

	it("removes the directory with no diagnostic when removal succeeds after transient failures", () => {
		const write = vi
			.spyOn(process.stderr, "write")
			.mockImplementation(() => true);
		const { tmpDir, cleanup } = dirWithFile();
		const passes = failRemoval(tmpDir, "EBUSY", 3);
		removeTempDirSync(tmpDir);
		expect(passes()).toBe(4);
		expect(existsSync(tmpDir)).toBe(false);
		expect(write).not.toHaveBeenCalled();
		cleanup();
	});
});

// A root with a detached leaf and a mid-tree shell that starts three sleepers
// and exits ON ITS OWN once its stdin (a pipe from the root) closes, that is,
// as soon as the root dies: its sleepers are then reparented mid-kill, the
// shape of pi's own wrapper children (npx). Prints every descendant pid.
const TREE = `
const { spawn } = require("child_process");
setTimeout(() => process.exit(0), 20000);
const leaf = spawn("sleep", ["20"], { detached: true, stdio: "ignore" });
const mid = spawn("sh", ["-c", "for i in 1 2 3; do sleep 20 & echo $!; done; read _"],
  { detached: true, stdio: ["pipe", "pipe", "ignore"] });
let out = "";
mid.stdout.on("data", (chunk) => {
  out += chunk;
  const grand = out.split("\\n").filter(Boolean).map(Number);
  if (grand.length === 3) console.log(JSON.stringify([leaf.pid, mid.pid, ...grand]));
});`;

// A root that keeps forking `sleep <argv[1]>` (200 in all, a few per tick)
// while it is being killed: the late fork the first snapshot cannot list. It
// says "go" once 20 exist, so every kill lands mid-stream, with sleepers both
// before and after its first snapshot.
const FORKER = `
const { spawn } = require("child_process");
setTimeout(() => process.exit(0), 20000);
let n = 0;
const tick = () => {
  for (let i = 0; i < 4 && n < 200; i++, n++)
    spawn("sleep", [process.argv[1]], { stdio: "ignore" });
  if (n === 20) console.log("go");
  if (n < 200) setImmediate(tick);
};
tick();`;

// A mid shell that starts three sleepers and then exits ON ITS OWN after
// argv[1] seconds, staggered by the test across the kill: some runs it exits
// after the kill's snapshot listed its children but before they are frozen,
// the window in which only adoption keeps them ours (state table row 4).
const RACER = `
const { spawn } = require("child_process");
setTimeout(() => process.exit(0), 20000);
const mid = spawn("sh", ["-c", "for i in 1 2 3; do sleep 5 & echo $!; done; sleep " + process.argv[1]],
  { detached: true, stdio: ["ignore", "pipe", "ignore"] });
let out = "";
mid.stdout.on("data", (chunk) => {
  out += chunk;
  const grand = out.split("\\n").filter(Boolean).map(Number);
  if (grand.length === 3) console.log(JSON.stringify(grand));
});`;

const firstLine = (child: ChildProcess) =>
	new Promise<string>((resolve) => {
		let out = "";
		child.stdout?.on("data", (chunk) => {
			out += String(chunk);
			if (out.includes("\n")) resolve(out.split("\n")[0] ?? "");
		});
	});

/** Live, non-zombie pids whose command line is `sleep <marker>` (Linux). */
function sleepersWith(marker: string): number[] {
	const out: number[] = [];
	for (const name of readdirSync("/proc")) {
		if (!/^\d+$/.test(name)) continue;
		try {
			const cmdline = readFileSync(`/proc/${name}/cmdline`, "utf8");
			if (cmdline === `sleep\0${marker}\0` && isProcessAlive(Number(name)))
				out.push(Number(name));
		} catch {
			// exited between readdir and read
		}
	}
	return out;
}

// Starts a detached `sleep argv[1]`, prints its pid and exits: the sleeper is
// reparented before this worker ever sees it as a descendant.
const ORPHAN = `
const c = require("child_process").spawn("sleep", [process.argv[1]], { detached: true, stdio: "ignore" });
c.unref();
console.log(c.pid);`;

async function orphan(
	seconds: string,
): Promise<{ parent: ChildProcess; pid: number }> {
	const parent = spawnNode(ORPHAN, seconds);
	const pid = Number(await firstLine(parent));
	await exited(parent);
	return { parent, pid };
}

// The guard's oracle (tests/support/kill-guard.ts `ownsPid`) had no test in
// either direction (#4082 verify r2, V2): making it permissive left every
// suite green. Signals are SIGCONT where delivery to a stranger must be
// harmless if the guard is broken, and SIGTERM where delivery is observable.
describe("kill-guard ownership (#2042)", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	// Recurrence: #2042, a fabricated or foreign pid reaching a real kill.
	it.skipIf(process.platform !== "linux")(
		"records and does not deliver signals to pids this worker does not own",
		async () => {
			vi.spyOn(console, "error").mockImplementation(() => {});
			const dead = spawnNode("");
			await exited(dead);
			const stranger = await orphan("5");
			const attempts: Array<[number, NodeJS.Signals]> = [
				[1, "SIGCONT"], // unrelated live pid (init)
				[process.ppid, "SIGCONT"], // this worker's own ancestor
				[dead.pid as number, "SIGTERM"], // reaped child
				[2468, "SIGCONT"], // fabricated pid, the #2042 literal
				[-2468, "SIGCONT"], // fabricated group
				[stranger.pid, "SIGTERM"], // reparented, never seen
			];
			const thrown = attempts.filter(([pid, signal]) => {
				try {
					process.kill(pid, signal);
					return false;
				} catch {
					return true;
				}
			});
			// A delivered SIGTERM lands asynchronously; give it 100 ms to show.
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
			expect({
				thrown,
				strangerAlive: isProcessAlive(stranger.pid),
				recorded: takeKillGuardViolationsForTest(
					attempts.map(([pid]) => pid),
				).map((v) => [v.site, v.target, v.detail]),
			}).toEqual({
				thrown: [],
				strangerAlive: true,
				recorded: attempts.map(([pid, signal]) => ["kill", pid, signal]),
			});
		},
		15_000,
	);

	// Recurrence (#5722 review F1): the guard's register arm wrapped a retired
	// slot while `safeSpawnAsync` added to the process-singleton cell, so the arm
	// went dead with no test red. A real production registration must land in
	// the cell the guard wrapped (the same family and version this reads
	// through the seam) and, being owned, record nothing.
	it.skipIf(process.platform !== "linux")(
		"safeSpawnAsync registers its owned child in the cell the guard wrapped",
		async () => {
			const pids = getProcessSingleton("safe-spawn-lifetime", 1, () => ({
				pids: new Set<number>(),
				installed: false,
			})).pids;
			const pending = safeSpawnAsync(
				process.execPath,
				["-e", "setTimeout(() => {}, 1500)"],
				{ lifetimeCoupled: true, timeout: 10_000 },
			);
			const registered = await waitFor(
				() => [...pids],
				(held) => held.length > 0,
				{ timeoutMs: 3_000 },
			);
			expect((await pending).status).toBe(0);
			expect({
				registered: registered.length,
				recorded: takeKillGuardViolationsForTest(registered),
				leftover: [...pids],
			}).toEqual({ registered: 1, recorded: [], leftover: [] });
		},
		15_000,
	);

	// Recurrence (#4082 verify r2, V1): a tree kill's grandchild, reparented
	// by its parent's death, was refused. Adopted while its parent (a child of
	// this worker) was live, it is signalled after the reparenting; the same
	// adoption under a root this worker does not own adopts nothing.
	it.skipIf(process.platform !== "linux")(
		"delivers to a reparented descendant adopted under an owned root, and only then",
		async () => {
			vi.spyOn(console, "error").mockImplementation(() => {});
			const parent = spawnNode(`${ORPHAN}\nsetInterval(() => {}, 1000);`, "5");
			const grandchild = Number(await firstLine(parent));
			adoptProcessTree(parent.pid as number, [grandchild]);
			parent.kill("SIGKILL");
			await exited(parent);
			const foreign = await orphan("5");
			adoptProcessTree(process.ppid, [foreign.pid]);
			process.kill(grandchild, "SIGTERM");
			process.kill(foreign.pid, "SIGTERM");
			await waitForChildExit(parent, [grandchild], 2_000);
			expect({
				grandchildAlive: isProcessAlive(grandchild),
				foreignAlive: isProcessAlive(foreign.pid),
				recorded: takeKillGuardViolationsForTest([grandchild, foreign.pid]).map(
					(v) => v.target,
				),
			}).toEqual({
				grandchildAlive: false,
				foreignAlive: true,
				recorded: [foreign.pid],
			});
		},
		15_000,
	);
});

describe("killProcessTree under the kill guard (#2042, #4081)", () => {
	const stray: ChildProcess[] = [];
	afterEach(() => {
		for (const child of stray.splice(0)) child.kill("SIGKILL");
		vi.restoreAllMocks();
	});

	// Recurrence (#4082 verify r2, V1): the tree kill signalled the root first,
	// the root's death reparented its children, and the guard, re-reading
	// /proc at signal time, recorded every later signal as a kill of an
	// unowned pid and did not deliver it: descendants survived and the file
	// failed in afterAll (11 of 14 real-harness runs). A mid-tree process that
	// exits by itself reparents its children the same way.
	it.skipIf(process.platform !== "linux")(
		"kills every descendant of 20 trees with a self-exiting mid process, and the guard records nothing",
		async () => {
			const decoy = spawnNode("setInterval(() => {}, 1000)");
			stray.push(decoy);
			let survivors = 0;
			let killed = 0;
			for (let run = 0; run < 20; run++) {
				const root = spawnNode(TREE);
				stray.push(root);
				const pids = JSON.parse(await firstLine(root)) as number[];
				killed += killProcessTree(root).length;
				await exited(root);
				await waitForChildExit(root, pids, 2_000);
				survivors += pids.filter((pid) => isProcessAlive(pid)).length;
			}
			expect({
				survivors,
				killed,
				decoy: isProcessAlive(decoy.pid as number),
				report: killGuardReport(),
			}).toEqual({
				survivors: 0,
				killed: 20 * 6,
				decoy: true,
				report: undefined,
			});
		},
		60_000,
	);

	// Recurrence (#4082 verify r2, V1, state table row 4): a mid process that
	// exits by itself after the snapshot reparents its children before they
	// are signalled; a guard that re-derives ancestry then refuses them (with
	// round 2's ancestry rule and no adoption: 10 and 20 records in two runs).
	// Children of a mid that exited before the snapshot are never listed
	// (row 5, the stated limit), so only the listed pids are asserted.
	it.skipIf(process.platform !== "linux")(
		"kills every listed pid when a mid process exits by itself around the kill",
		async () => {
			let listedGrandchildren = 0;
			let survivors = 0;
			for (let run = 0; run < 40; run++) {
				const root = spawnNode(RACER, ((run % 20) * 0.003).toFixed(3));
				stray.push(root);
				const grandchildren = JSON.parse(await firstLine(root)) as number[];
				const listed = killProcessTree(root);
				await exited(root);
				await waitForChildExit(root, listed, 2_000);
				listedGrandchildren += grandchildren.filter((pid) =>
					listed.includes(pid),
				).length;
				survivors += listed.filter((pid) => isProcessAlive(pid)).length;
			}
			expect(listedGrandchildren).toBeGreaterThan(0);
			expect({ survivors, report: killGuardReport() }).toEqual({
				survivors: 0,
				report: undefined,
			});
		},
		60_000,
	);

	// Recurrence (#4081 round 2's stated limit): a process the root forks after
	// the one `ps` snapshot was never signalled, was reparented when the root
	// died, and kept running (and, under pi, writing under the scratch home).
	it.skipIf(process.platform !== "linux")(
		"also kills processes the root forks while it is being killed",
		async () => {
			const marker = `3.${process.pid}${Date.now() % 1000}`;
			let survivors = 0;
			for (let run = 0; run < 5; run++) {
				const root = spawnNode(FORKER, marker);
				stray.push(root);
				await firstLine(root);
				killProcessTree(root);
				await exited(root);
				// SIGKILL lands asynchronously: give the signalled ones a bounded moment.
				await waitForChildExit(root, sleepersWith(marker), 1_000);
				survivors += sleepersWith(marker).length;
			}
			expect({ survivors, report: killGuardReport() }).toEqual({
				survivors: 0,
				report: undefined,
			});
		},
		60_000,
	);
});
