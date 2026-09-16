/**
 * #2042 — the suite's own SIGKILL.
 *
 * `tests/clients/lsp/launch.test.ts` mocked `node:child_process` with a fake
 * child whose pid was the literal `2468`. The PRODUCTION path
 * (`launchLSP` -> `package-manager.isAvailable` -> `probeToolAsync` ->
 * `safeSpawnAsync("which")`) registered that invented pid in the real
 * `lifetimeState.pids`; the fake never emitted `close`, so `finalize()` never
 * removed it, and at fork teardown `installLifetimeCleanup()`'s `exit`
 * handler ran `process.kill(-2468, "SIGKILL")` then
 * `process.kill(2468, "SIGKILL")`. On ~10 % of GitHub runners pid 2468 was
 * one of the job's own long-lived processes: `Killed npm test`, exit 137, no
 * failing assertion, no kernel record — five weeks of "infra kill" reruns.
 *
 * Every case below drives the REAL seam (`safeSpawnAsync`, `killProcessTree`)
 * with a child_process double, never a hand-fed pid list, and the foreign pid
 * is `process.ppid`: a process that provably exists and provably is not our
 * child, so the assertions are deterministic on any Linux host rather than
 * depending on whether an invented number happens to be live.
 *
 * `process.kill` is mocked in every case that could reach it, so a regression
 * here can never deliver a real signal to the runner.
 */
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import { isOwnLiveChild } from "../../clients/safe-spawn.js";

/** The registry `clients/safe-spawn.ts` shares across module instances. */
const LIFETIME_STATE_KEY = Symbol.for("pi-lens.safe-spawn.lifetime-state");

function lifetimePids(): Set<number> {
	const host = process as typeof process & {
		[LIFETIME_STATE_KEY]?: { pids: Set<number>; installed: boolean };
	};
	return host[LIFETIME_STATE_KEY]?.pids ?? new Set<number>();
}

class FakeStream extends EventEmitter {
	write() {
		return true;
	}
	end() {}
	setEncoding() {}
}

/** A child_process double that never terminates — exactly the #2042 fake. */
class FakeChild extends EventEmitter {
	stdin = new FakeStream();
	stdout = new FakeStream();
	stderr = new FakeStream();
	exitCode: number | null = null;
	signalCode: NodeJS.Signals | null = null;
	killed = false;
	kill = vi.fn(() => {
		this.killed = true;
		return true;
	});
	unref() {}
	constructor(public pid: number) {
		super();
	}
}

describe("kill-by-pid ownership (#2042)", () => {
	let exitListenersBefore: ReadonlyArray<unknown> = [];

	beforeEach(() => {
		resetDegradationLedger();
		exitListenersBefore = process.listeners("exit");
	});

	afterEach(() => {
		// Remove anything production installed during the case, so a leaked
		// exit handler cannot fire against a later file's state.
		for (const listener of process.listeners("exit")) {
			if (!exitListenersBefore.includes(listener))
				process.off("exit", listener as () => void);
		}
		vi.restoreAllMocks();
		vi.doUnmock("node:child_process");
		// node:fs is mocked by the /proc-unreadable case; a leaked fs mock makes
		// every later ownership read fail, which is silently INDISTINGUISHABLE
		// from the fix working (defect shape 7).
		vi.doUnmock("node:fs");
		vi.resetModules();
	});

	it("refuses a malformed pid at every site", () => {
		expect(isOwnLiveChild(0, "test")).toBe(false);
		expect(isOwnLiveChild(-1, "test")).toBe(false);
		expect(isOwnLiveChild(undefined, "test")).toBe(false);
		expect(isOwnLiveChild(Number.NaN, "test")).toBe(false);
	});

	/**
	 * The handle arm is the ONLY ownership evidence a platform without `/proc`
	 * has — `lsp/launch.ts#killWindowsTree`'s recycled-pid protection (a
	 * `taskkill /F /T` on a dead pid destroys whatever process inherited the
	 * number, and once took out a vitest worker fork) now lives in this
	 * predicate. `/proc` availability is probed once at MODULE LOAD (#3091 F4),
	 * so this drives a fresh import with the platform already stubbed rather
	 * than a Windows-only lane — AGENTS.md shape 30, and the platform rule's
	 * preferred cross-platform variant: the divergence is a `/proc` artifact,
	 * not real Windows behaviour, so the ubuntu lane runs it.
	 */
	it("on a platform without /proc, only the handle can refuse a pid", async () => {
		const real = Object.getOwnPropertyDescriptor(process, "platform");
		Object.defineProperty(process, "platform", {
			value: "win32",
			configurable: true,
		});
		try {
			vi.resetModules();
			const { isOwnLiveChild: fresh } =
				await import("../../clients/safe-spawn.js");
			const { getDegradationSummary: freshSummary } =
				await import("../../clients/degradation-ledger.js");
			// Best-effort stays best-effort where ownership is unverifiable...
			expect(fresh(process.ppid, "test")).toBe(true);
			// ...and it is NOT a degradation here: a platform that never had
			// /proc is the expected case, so the fallback row must stay silent
			// rather than fire on every Windows and macOS spawn. That row exists
			// for a LINUX host whose /proc cannot answer (#3091 F4).
			expect(
				freshSummary().some(
					(entry) => entry.kind === "kill-ownership-unverifiable",
				),
			).toBe(false);
			// ...but a handle that already reported exit is proof it is dead, and
			// it overrides everything, including the memo.
			expect(fresh(process.ppid, "test", { exitCode: 0 })).toBe(false);
			expect(fresh(process.ppid, "test", { signalCode: "SIGTERM" })).toBe(
				false,
			);
		} finally {
			if (real) Object.defineProperty(process, "platform", real);
		}
	});

	// Everything below reads `/proc`, which only Linux has. The Windows and
	// macOS arms of the same predicate are covered above WITHOUT a lane, by the
	// fresh-import case that stubs the platform before module load.
	// lane: ubuntu Unit tests.
	describe.skipIf(process.platform !== "linux")(
		"on Linux, where /proc answers",
		() => {
			/**
			 * #3091 F4: `process.platform === "linux"` is not the same question as "can
			 * I read /proc". A Linux host with `/proc` unmounted made every per-pid read
			 * fail exactly the way a dead pid does, so nothing was ever registered and
			 * the host-exit tree kill silently stopped working.
			 */
			it("falls back to best-effort, with a record, when /proc is unreadable on Linux", async () => {
				vi.resetModules();
				vi.doMock("node:fs", async (importOriginal) => {
					const actual = await importOriginal<typeof import("node:fs")>();
					return {
						...actual,
						default: actual,
						readFileSync: (file: unknown, ...rest: unknown[]) => {
							if (typeof file === "string" && file.startsWith("/proc/"))
								throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
							return (actual.readFileSync as (...args: unknown[]) => unknown)(
								file,
								...rest,
							);
						},
					};
				});
				const { isOwnLiveChild: fresh } =
					await import("../../clients/safe-spawn.js");
				// The ledger must be the instance the FRESH safe-spawn writes to —
				// `vi.resetModules()` gives it a new one, and reading the statically
				// imported twin would report an empty ledger (defect shape 14).
				const { getDegradationSummary: freshSummary } =
					await import("../../clients/degradation-ledger.js");

				// Best-effort, exactly as on a platform that never had /proc — NOT a
				// silent refusal that disables every kill (defect shape 10).
				expect(fresh(process.ppid, "proc-unreadable-site")).toBe(true);
				fresh(process.ppid, "proc-unreadable-site");

				const group = freshSummary().find(
					(entry) => entry.kind === "kill-ownership-unverifiable",
				);
				expect(group?.latestReasons.map((entry) => entry.subject)).toEqual([
					"proc-unreadable-site",
				]);
				// Once per session, not once per call.
				expect(group?.count).toBe(1);
			});

			it("refuses a live pid belonging to another parent, and records it once per site", () => {
				expect(isOwnLiveChild(process.ppid, "test-site")).toBe(false);
				const group = getDegradationSummary().find(
					(entry) => entry.kind === "kill-foreign-pid-refused",
				);
				expect(group?.latestReasons.map((entry) => entry.subject)).toEqual([
					"test-site",
				]);
				expect(group?.latestReasons[0]?.reason).toContain(
					`pid ${process.ppid} has parent`,
				);
				// Bounded: the subject is the SITE, so a second refusal of a
				// different pid raises the count and never the entry list.
				isOwnLiveChild(process.ppid, "test-site");
				const after = getDegradationSummary().find(
					(entry) => entry.kind === "kill-foreign-pid-refused",
				);
				expect(after?.count).toBe(2);
				expect(after?.latestReasons).toHaveLength(1);
			});

			it("a fabricated child pid never enters the lifetime registry, so host exit never signals it", async () => {
				const foreignPid = process.ppid;
				const child = new FakeChild(foreignPid);
				// Resolved by the double the instant production spawns: registration
				// is the next synchronous statement, so one microtask later the
				// registry has seen everything this call will ever add to it. No
				// wall-clock wait.
				let spawned!: () => void;
				const hasSpawned = new Promise<void>((resolve) => {
					spawned = resolve;
				});
				vi.doMock("node:child_process", () => ({
					spawn: vi.fn(() => {
						queueMicrotask(spawned);
						return child;
					}),
					spawnSync: vi.fn(() => ({ status: 0, stdout: "", stderr: "" })),
					execSync: vi.fn(() => ""),
					execFileSync: vi.fn(() => ""),
				}));
				const { safeSpawnAsync } = await import("../../clients/safe-spawn.js");

				const pending = safeSpawnAsync("which", ["node"], { timeout: 50_000 });
				await hasSpawned;

				expect([...lifetimePids()]).not.toContain(foreignPid);

				// Fire whatever exit handlers production installed during the call —
				// the seam that shipped `process.kill(-2468, "SIGKILL")`.
				const killSpy = vi
					.spyOn(process, "kill")
					.mockImplementation(() => true as never);
				for (const listener of process.listeners("exit")) {
					if (!exitListenersBefore.includes(listener))
						(listener as (code: number) => void)(0);
				}
				expect(killSpy).not.toHaveBeenCalled();

				child.emit("close", 0, null);
				await pending;
			});

			it("a timeout kill on a fabricated child pid signals the handle, never the process group", async () => {
				const foreignPid = process.ppid;
				const child = new FakeChild(foreignPid);
				// The double terminates the way a real child does — on whichever
				// kill production actually chooses — so the call settles without a
				// wall-clock wait, and the assertions below read which one it was.
				const settle = () => {
					queueMicrotask(() => child.emit("close", null, "SIGTERM"));
					return true as never;
				};
				child.kill.mockImplementation(settle);
				vi.doMock("node:child_process", () => ({
					spawn: vi.fn(() => child),
					spawnSync: vi.fn(() => ({ status: 0, stdout: "", stderr: "" })),
					execSync: vi.fn(() => ""),
					execFileSync: vi.fn(() => ""),
				}));
				const { safeSpawnAsync } = await import("../../clients/safe-spawn.js");
				const killSpy = vi.spyOn(process, "kill").mockImplementation(settle);

				await safeSpawnAsync("which", ["node"], { timeout: 10 });

				expect(killSpy).not.toHaveBeenCalled();
				expect(child.kill).toHaveBeenCalledWith("SIGTERM");
			});

			it("killProcessTree's POSIX group kill refuses a pid the process does not own", async () => {
				const foreignPid = process.ppid;
				const proc = new FakeChild(foreignPid);
				const killSpy = vi
					.spyOn(process, "kill")
					.mockImplementation(() => true as never);
				const { killProcessTree } = await import("../../clients/lsp/client.js");

				await killProcessTree(proc as never, foreignPid, { fast: true });

				expect(killSpy).not.toHaveBeenCalled();
				// The handle-based fallback still runs: an unowned pid must not turn
				// shutdown into a no-op (defect shape 10, silencing as fixing).
				expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
			});
		},
	);
});
