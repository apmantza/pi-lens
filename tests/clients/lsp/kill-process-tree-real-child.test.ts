// flake-shape: real-process-spawn — a real, live direct child is the ONLY pid whose /proc PPid is this process, so the Linux ownership arm of `isOwnLiveChild` cannot be observed through any double; #3091 round 1 shipped a regression at exactly this site because every case that reached it stubbed the platform away.
/**
 * #2042 / PR #3091 F1 — the Linux ownership arm of `killProcessTree`, against a
 * real child.
 *
 * Round 1 gated `clients/lsp/client.ts#killPosixProcessGroup` on
 * `isOwnLiveChild(pid, site, proc)` and passed the ChildProcess handle. The
 * handle arm ("already reported exit ⇒ refuse") then fired on the
 * `processExiting` path, where `killProcessTree`'s early return at
 * `clients/lsp/client.ts:1269` is deliberately SKIPPED and an already-dead
 * direct child can reach the group kill (the code says so at
 * `clients/lsp/client.ts:1382`). That group SIGTERM is the only thing that
 * reaps surviving grandchildren at host exit (#2026), so the fix turned it off:
 * master signalled `[[-3164880,"SIGTERM"]]`, the round-1 head signalled `[]`.
 *
 * Every other case in this family stubs `process.platform`, so none of them
 * could see it. These do not stub anything: they spawn a real detached child,
 * whose `/proc/<pid>/status` really does carry `PPid: <this process>`.
 *
 * lane: ubuntu Unit tests (`describe.skipIf(process.platform !== "linux")` — the
 * ownership arm reads `/proc`, which only exists there; the Windows arm is
 * covered without a lane by the platform-stubbed case in
 * tests/clients/safe-spawn-kill-ownership.test.ts).
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../../clients/degradation-ledger.js";
import {
	flushLatencyLog,
	getLatencyLogPath,
} from "../../../clients/latency-logger.js";
import { killProcessTree } from "../../../clients/lsp/client.js";
import { launchLSP, type LSPProcess } from "../../../clients/lsp/launch.js";
import {
	isOwnLiveChild,
	releaseOwnChildPid,
	VERIFIED_OWN_PID_CAP,
} from "../../../clients/safe-spawn.js";
import { withEnv } from "../../support/with-env.js";

const children: ChildProcess[] = [];

const handles: LSPProcess[] = [];

/**
 * The production spawn path, with a real command whose LEADER can be reaped
 * while the group lives on: `sleep 30` keeps process group `pid` alive after
 * the `sh` leader is gone — #2026's shape, the grandchild the group signal
 * exists to reach.
 */
async function launchLspGroup(
	script = "sleep 30 & sleep 60",
): Promise<LSPProcess> {
	const handle = await launchLSP("/bin/sh", ["-c", script], {
		cwd: process.cwd(),
	});
	handles.push(handle);
	children.push(handle.process);
	return handle;
}

/**
 * #5733 F1: a group whose leader (`sh`) exits on SIGTERM while a descendant
 * in the same group ignores it. The descendant writes its pid only after
 * its SIGTERM disposition is set (inherited across `exec`), so no signal can
 * reach it before it is stubborn.
 */
async function launchGroupOutlivingItsLeader(): Promise<{
	handle: LSPProcess;
	descendant: number;
}> {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "f1-5733-"));
	const pidFile = path.join(dir, "descendant.pid");
	const handle = await launchLSP(
		"/bin/sh",
		[
			"-c",
			`(trap '' TERM; exec /bin/sh -c 'echo $$ > "$0"; exec sleep 60' "$1") & wait`,
			"sh",
			pidFile,
		],
		{ cwd: process.cwd() },
	);
	handles.push(handle);
	children.push(handle.process);
	const descendant = await vi.waitFor(
		() => {
			const pid = Number(fs.readFileSync(pidFile, "utf8").trim());
			if (!(pid > 0)) throw new Error("descendant not started");
			return pid;
		},
		{ timeout: 10_000, interval: 20 },
	);
	fs.rmSync(dir, { recursive: true, force: true });
	return { handle, descendant };
}

/** Gone, or a zombie nobody will run again. */
function isGone(pid: number): boolean {
	try {
		const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
		return stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z");
	} catch {
		return true;
	}
}

function outlivedLeaderRows() {
	return getDegradationSummary().filter(
		(row) => row.kind === "held-group-outlived-leader",
	);
}

/** A real child in its OWN process group, so `-pid` is a real group id. */
function spawnDetachedSleeper(): ChildProcess {
	const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
		detached: true,
		stdio: "ignore",
	});
	children.push(child);
	return child;
}

function exited(child: ChildProcess): Promise<void> {
	return new Promise((resolve) => {
		if (child.exitCode !== null || child.signalCode !== null) {
			resolve();
			return;
		}
		child.once("exit", () => resolve());
	});
}

afterEach(async () => {
	vi.restoreAllMocks();
	while (children.length > 0) {
		const child = children.pop();
		if (!child?.pid) continue;
		// Issued BY a child, not by this process: once the leader is reaped the
		// group id is a pid this process can no longer prove it owns, and the
		// #2042 kill guard is right to refuse it from here.
		spawnSync("/bin/sh", [
			"-c",
			`kill -9 -${child.pid} 2>/dev/null; kill -9 ${child.pid} 2>/dev/null; true`,
		]);
		await exited(child);
	}
});

describe.skipIf(process.platform !== "linux")(
	"killProcessTree ownership, against a real child (#2042)",
	() => {
		it("signals the process group of a live child this process really owns", async () => {
			const child = spawnDetachedSleeper();
			const pid = child.pid as number;
			// callThrough: the signal is REAL, and it is our own child — the
			// positive arm is worth nothing if the kill is mocked away.
			const killSpy = vi.spyOn(process, "kill");

			await killProcessTree(
				{ kill: () => true, unref: () => {}, exitCode: null },
				pid,
				{ fast: true },
			);

			expect(killSpy).toHaveBeenCalledWith(-pid, "SIGTERM");
			await exited(child);
		});

		it("still group-kills at host exit when the handle already reported exit (F1)", async () => {
			// The `processExiting` path: `killProcessTree`'s exited early return
			// is skipped, and the handle can legitimately say "exited" while the
			// GROUP is still alive with grandchildren in it. Ownership must come
			// from the kernel, not from the handle.
			const child = spawnDetachedSleeper();
			const pid = child.pid as number;
			const handle = { kill: vi.fn(() => true), unref: vi.fn(), exitCode: 0 };
			const killSpy = vi.spyOn(process, "kill");

			await killProcessTree(handle, pid, {
				fast: true,
				processExiting: true,
			});

			expect(killSpy).toHaveBeenCalledWith(-pid, "SIGTERM");
			await exited(child);
		});

		it("group-kills a dead leader this process spawned but never individually verified (F1-r2)", async () => {
			// LSP children come from `nodeSpawn` at clients/lsp/launch.ts:371 and
			// :381, never through `safeSpawnAsync`, so before F1-r2 their FIRST
			// verification attempt WAS the shutdown group kill — and on the
			// `processExiting` path the leader can already be dead by then, which
			// is `/proc` gone and a memo nobody ever filled. Ownership has to be
			// taken at ADMISSION (AGENTS.md shape 50), which is what
			// `holdOwnChildPid` at the spawn site does.
			// The REAL spawn path: `launchLSP` -> `nodeSpawn`, detached, exactly
			// as a language server is started. Nothing in this test verifies the
			// pid; if production does not take ownership at admission, nothing
			// ever will.
			const handle = await launchLspGroup();
			const pid = handle.pid;
			// Kill the LEADER only and reap it: the group (its `sleep`) is still
			// alive, which is exactly the #2026 case the group signal exists for.
			process.kill(pid, "SIGKILL");
			await exited(handle.process);
			expect(fs.existsSync(`/proc/${pid}`)).toBe(false);

			const killSpy = vi.spyOn(process, "kill");
			await killProcessTree(handle.process, pid, {
				fast: true,
				processExiting: true,
			});

			expect(killSpy).toHaveBeenCalledWith(-pid, "SIGTERM");
		});

		it("keeps the hold until the escalation SIGKILL has been issued, not before", async () => {
			// The fast path's 1.5s escalation is the LAST signal a pid can get.
			// Retiring the ownership hold at the top of that tick instead of the
			// bottom makes the escalation itself the refused signal — the #2027
			// SIGTERM-hardy grandchild survives, which is the whole failure this
			// ladder exists to prevent.
			const handle = await launchLspGroup();
			const pid = handle.pid;
			process.kill(pid, "SIGKILL");
			await exited(handle.process);

			// A handle that never reports exit: `exited` stays false, so the
			// escalation is reached. Fake timers, so no wall-clock wait.
			const stale = {
				kill: vi.fn(() => true),
				unref: vi.fn(),
				exitCode: null,
				signalCode: null,
				once: vi.fn(),
				off: vi.fn(),
			};
			const killSpy = vi.spyOn(process, "kill");
			vi.useFakeTimers();
			try {
				await killProcessTree(stale, pid, {
					fast: true,
					processExiting: true,
				});
				expect(killSpy).toHaveBeenCalledWith(-pid, "SIGTERM");
				await vi.advanceTimersByTimeAsync(1500);
				expect(killSpy).toHaveBeenCalledWith(-pid, "SIGKILL");
			} finally {
				vi.useRealTimers();
			}
		});

		it("a released hold is gone from BOTH stores, not just the held one", async () => {
			// The independent assertion that "one home" holds. `holdOwnChildPid`
			// deletes the FIFO copy the verification it performs would otherwise
			// leave behind; without that deletion a RELEASED pid still answers
			// true out of the FIFO, and — the reason this case exists — the FIFO
			// copy also answers for the held copy, which is what made the
			// held-store and release-ordering mutations undetectable in this
			// file's first draft (#3091 round 3).
			const handle = await launchLspGroup();
			const pid = handle.pid;
			expect(isOwnLiveChild(pid, "held-while-alive")).toBe(true);

			releaseOwnChildPid(pid);
			process.kill(pid, "SIGKILL");
			await exited(handle.process);
			expect(fs.existsSync(`/proc/${pid}`)).toBe(false);

			expect(isOwnLiveChild(pid, "after-release")).toBe(false);
		});

		// #5733 F1: the ladder released the hold on the leader's exit, so a
		// descendant that ignored SIGTERM outlived the shutdown AND the host,
		// whose exit handler kills only held groups.
		it("ends a group that outlives its SIGTERM-exited leader before releasing it (#5733 F1)", async () => {
			resetDegradationLedger();
			const { handle, descendant } = await launchGroupOutlivingItsLeader();
			const pid = handle.pid;

			await killProcessTree(handle.process, pid);

			expect(handle.process.signalCode).toBe("SIGTERM");
			await vi.waitFor(
				() => {
					if (!isGone(descendant)) throw new Error("descendant alive");
				},
				{ timeout: 3_000, interval: 20 },
			);
			expect(isOwnLiveChild(pid, "after-group-end")).toBe(false);
			expect(outlivedLeaderRows()).toMatchObject([
				{ count: 1, latestReasons: [{ subject: "lsp-shutdown" }] },
			]);
		});

		it("keeps the hold through the fast window while the group outlives its leader (#5733 F1)", async () => {
			resetDegradationLedger();
			const { handle, descendant } = await launchGroupOutlivingItsLeader();
			const pid = handle.pid;
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
			try {
				await killProcessTree(handle.process, pid, { fast: true });
				await exited(handle.process);
				// The leader is gone and the group is not: the hold is what lets
				// the host-exit handlers still SIGKILL it inside this window.
				expect(isGone(descendant)).toBe(false);
				expect(isOwnLiveChild(pid, "fast-window")).toBe(true);

				await vi.advanceTimersByTimeAsync(1500);
			} finally {
				vi.useRealTimers();
			}
			await vi.waitFor(
				() => {
					if (!isGone(descendant)) throw new Error("descendant alive");
				},
				{ timeout: 3_000, interval: 20 },
			);
			expect(isOwnLiveChild(pid, "after-fast-tick")).toBe(false);
		});

		it("a held pid survives past the FIFO cap, where an aged verdict does not (F1-r2b)", async () => {
			// Age is the wrong retirement axis for a resource-scoped verdict: a
			// long-lived LSP leader is the OLDEST entry in a FIFO that every
			// `safeSpawnAsync` writes to, so it is the FIRST evicted. Held pids
			// are not in that FIFO at all.
			const handle = await launchLspGroup();
			const pid = handle.pid;
			process.kill(pid, "SIGKILL");
			await exited(handle.process);

			// More verdicts than the cap, each from a REAL child so the predicate
			// actually files it — `isOwnLiveChild(process.pid, …)` would not, and
			// a filler that files nothing evicts nothing. This is what a busy
			// session's `safeSpawnAsync` traffic does to a FIFO.
			for (let index = 0; index < VERIFIED_OWN_PID_CAP + 8; index += 1) {
				const filler = spawn("/bin/true", [], { stdio: "ignore" });
				expect(isOwnLiveChild(filler.pid as number, "filler")).toBe(true);
			}

			const killSpy = vi.spyOn(process, "kill");
			await killProcessTree(handle.process, pid, {
				fast: true,
				processExiting: true,
			});

			expect(killSpy).toHaveBeenCalledWith(-pid, "SIGTERM");
		});

		it("a leader verified while alive stays signalable once it dies; one never verified does not", async () => {
			// #2026/#2027: the 1.5s escalation SIGKILLs the GROUP after the direct
			// child has already died, which is how a SIGTERM-hardy grandchild is
			// reached. `/proc/<leader>` is gone by then, so ownership has to be
			// remembered from when it was verifiable.
			const verified = spawnDetachedSleeper();
			const verifiedPid = verified.pid as number;
			expect(isOwnLiveChild(verifiedPid, "test-memo")).toBe(true);

			const unverified = spawnDetachedSleeper();
			const unverifiedPid = unverified.pid as number;

			process.kill(-verifiedPid, "SIGKILL");
			process.kill(-unverifiedPid, "SIGKILL");
			await exited(verified);
			await exited(unverified);

			expect(isOwnLiveChild(verifiedPid, "test-memo")).toBe(true);
			expect(isOwnLiveChild(unverifiedPid, "test-memo")).toBe(false);
		});
	},
);

// `HELD_OWN_PID_SWEEP_AT` in clients/safe-spawn.ts, restated: the issue's own
// number, so a changed ceiling reds these cases instead of following it.
const HELD_CEILING = 256;

/**
 * `held[0]` is launched alone so it is provably the oldest held pid; the rest
 * go out together (admission order among them does not matter to any case),
 * which keeps 256 real `launchLSP` calls to a few seconds.
 */
async function fillHeldCeiling(): Promise<LSPProcess[]> {
	const held = [await launchLspGroup("exec sleep 60")];
	held.push(
		...(await Promise.all(
			Array.from({ length: HELD_CEILING - 1 }, () =>
				launchLspGroup("exec sleep 60"),
			),
		)),
	);
	return held;
}

function evictionRows() {
	return getDegradationSummary().filter(
		(row) => row.kind === "held-own-pid-evicted",
	);
}

async function reapAll(held: LSPProcess[]): Promise<void> {
	for (const handle of held) handle.process.kill("SIGKILL");
	await Promise.all(held.map((handle) => exited(handle.process)));
	for (const handle of held) {
		expect(fs.existsSync(`/proc/${handle.pid}`)).toBe(false);
	}
}

describe.skipIf(process.platform !== "linux")(
	"holdOwnChildPid at the held-pid ceiling, against real launchLSP children (#3096)",
	() => {
		it("records one bounded degradation when a live held leader is dropped, and silently admits below it", async () => {
			resetDegradationLedger();
			// The latency sink is off in test mode; this case reads the real one.
			const restoreEnv = withEnv({ PI_LENS_TEST_MODE: "0" });
			const held: LSPProcess[] = [];
			try {
				held.push(...(await fillHeldCeiling()));
				// 256 live groups held: nothing was dropped, so nothing is recorded.
				expect(evictionRows()).toEqual([]);

				// The 257th launch finds every held group alive; the oldest goes.
				held.push(await launchLspGroup("exec sleep 60"));
				const rows = evictionRows();
				expect(rows).toHaveLength(1);
				expect(rows[0]?.count).toBe(1);
				expect(rows[0]?.latestReasons).toEqual([
					{
						subject: "lsp-spawn",
						reason: expect.stringContaining(`pid ${held[0]!.pid}`),
					},
				]);

				await flushLatencyLog();
				const durable = fs
					.readFileSync(getLatencyLogPath(), "utf8")
					.trim()
					.split("\n")
					.map((line) => JSON.parse(line))
					.filter(
						(row) =>
							row.phase === "degradation_ledger" &&
							row.metadata?.kind === "held-own-pid-evicted",
					);
				expect(durable).toHaveLength(1);
				expect(durable[0].metadata).toMatchObject({
					subject: "lsp-spawn",
					count: 1,
					evicted: "1",
				});

				// The record names a real loss: the dropped leader, once dead, is no
				// longer answerable; any other held leader still is.
				held[0]!.process.kill("SIGKILL");
				held[1]!.process.kill("SIGKILL");
				await exited(held[0]!.process);
				await exited(held[1]!.process);
				expect(isOwnLiveChild(held[0]!.pid, "after-evict")).toBe(false);
				expect(isOwnLiveChild(held[1]!.pid, "after-evict")).toBe(true);
			} finally {
				restoreEnv();
				await reapAll(held);
			}
		}, 60_000);

		it("sweeps a dead group before admitting, so a full set with one dead member drops nothing (state C)", async () => {
			resetDegradationLedger();
			const held = await fillHeldCeiling();
			try {
				held[10]!.process.kill("SIGKILL");
				await exited(held[10]!.process);

				held.push(await launchLspGroup("exec sleep 60"));
				expect(evictionRows()).toEqual([]);

				// The oldest live leader is still held: dead, it stays answerable.
				held[0]!.process.kill("SIGKILL");
				await exited(held[0]!.process);
				expect(isOwnLiveChild(held[0]!.pid, "after-sweep")).toBe(true);
			} finally {
				await reapAll(held);
			}
		}, 60_000);
	},
);
