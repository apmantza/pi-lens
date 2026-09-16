/**
 * Guards the Windows process-exit teardown path. On `session_shutdown` (e.g.
 * during `pi update`) the event loop is already closing, so spawning a child
 * process to kill LSP servers makes libuv call uv_async_send on the closing
 * loop-wakeup handle and hard-aborts:
 *
 *   Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), src\win\async.c
 *
 * killProcessTree must therefore kill via the handle it already holds
 * (TerminateProcess — synchronous, no new async handle) when `processExiting`
 * is set, and only fall back to the `taskkill /T` tree-kill spawn for
 * mid-session shutdowns where the host keeps running.
 */

import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";

const spawnMock = vi.fn((..._args: unknown[]) => ({
	once: vi.fn(),
	unref: vi.fn(),
}));
vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return { ...actual, spawn: spawnMock };
});

/**
 * #3091 F4 made `/proc` availability a MODULE-LOAD probe in
 * `clients/safe-spawn.ts`, so a platform stub applied inside a test no longer
 * reaches the ownership predicate — the stub has to be in place before the
 * module graph is imported. Each block below therefore loads its own instance
 * with its own platform (AGENTS.md shape 30: "use a live platform read or an
 * isolated fresh import for every platform branch test"), instead of one
 * top-level import shared by two platforms.
 */
type KillProcessTree =
	(typeof import("../../../clients/lsp/client.js"))["killProcessTree"];

async function importForPlatform(
	platform: NodeJS.Platform,
): Promise<KillProcessTree> {
	Object.defineProperty(process, "platform", {
		value: platform,
		configurable: true,
	});
	vi.resetModules();
	return (await import("../../../clients/lsp/client.js")).killProcessTree;
}

describe("killProcessTree", () => {
	const realPlatform = process.platform;
	let killProcessTree: KillProcessTree;
	let processKillSpy: ReturnType<typeof vi.spyOn> | undefined;

	afterEach(() => {
		Object.defineProperty(process, "platform", {
			value: realPlatform,
			configurable: true,
		});
		processKillSpy?.mockRestore();
		processKillSpy = undefined;
		vi.useRealTimers();
	});

	describe("Windows process-exit teardown", () => {
		beforeAll(async () => {
			killProcessTree = await importForPlatform("win32");
		});

		beforeEach(() => {
			spawnMock.mockClear();
			Object.defineProperty(process, "platform", {
				value: "win32",
				configurable: true,
			});
		});

		it("processExiting: kills via the existing handle and NEVER spawns taskkill", async () => {
			const proc = { kill: vi.fn(() => true), unref: vi.fn() };
			await killProcessTree(proc, 4242, { fast: true, processExiting: true });
			// The whole point: no child spawn while the loop is closing.
			expect(spawnMock).not.toHaveBeenCalled();
			expect(proc.kill).toHaveBeenCalled();
			expect(proc.unref).toHaveBeenCalled();
		});

		it("non-exiting fast shutdown kills wrapper descendants via taskkill /T", async () => {
			const proc = { kill: vi.fn(() => true), unref: vi.fn() };
			await killProcessTree(proc, 4242, { fast: true });
			expect(spawnMock).toHaveBeenCalledTimes(1);
			const call = spawnMock.mock.calls[0];
			expect(String(call[0]).toLowerCase()).toContain("taskkill");
			expect(call[1]).toEqual(expect.arrayContaining(["/T", "/PID", "4242"]));
		});
	});

	describe("POSIX process-group teardown", () => {
		// "darwin", not "linux". These cases exercise the escalation LADDER
		// (group SIGTERM -> 1.5s -> group SIGKILL, direct-child fallback)
		// against the fabricated pid 4242, and on Linux the #2042 ownership
		// predicate reads /proc and refuses to signal a pid this process does
		// not own — which is the point of the fix, and would make every
		// assertion below about a pid that belongs to nobody. A POSIX platform
		// without /proc keeps ownership unverifiable, which is the best-effort
		// behaviour these cases were written for. The LINUX arm of the same
		// ladder is driven against a REAL owned child in
		// tests/clients/lsp/kill-process-tree-real-child.test.ts, and the Linux
		// refusal in tests/clients/safe-spawn-kill-ownership.test.ts.
		beforeAll(async () => {
			killProcessTree = await importForPlatform("darwin");
		});

		beforeEach(() => {
			spawnMock.mockClear();
			Object.defineProperty(process, "platform", {
				value: "darwin",
				configurable: true,
			});
			// Fake timers keep the escalation test deterministic and stop the
			// unref'd 1500ms SIGKILL timer from firing against the real
			// process.kill once processKillSpy is restored.
			vi.useFakeTimers();
			processKillSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
		});

		it("fast shutdown signals the LSP process group before unref", async () => {
			const proc = { kill: vi.fn(() => true), unref: vi.fn() };
			await killProcessTree(proc, 4242, { fast: true });

			expect(processKillSpy).toHaveBeenCalledWith(-4242, "SIGTERM");
			expect(proc.kill).not.toHaveBeenCalledWith("SIGTERM");
			expect(proc.unref).toHaveBeenCalled();
		});

		it("falls back to the direct child when group signaling fails (ESRCH)", async () => {
			// A non-detached child has no process group whose id == pid, so
			// process.kill(-pid) throws ESRCH. Teardown must not give up — it
			// falls back to killing the handle we already hold.
			processKillSpy?.mockImplementation(() => {
				throw Object.assign(new Error("no such process"), { code: "ESRCH" });
			});
			const proc = { kill: vi.fn(() => true), unref: vi.fn() };
			await killProcessTree(proc, 4242, { fast: true });

			expect(processKillSpy).toHaveBeenCalledWith(-4242, "SIGTERM");
			expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
			expect(proc.unref).toHaveBeenCalled();
		});

		it("host-exit group kill still fires when the handle already reported exit", async () => {
			// #3091 F1, the arm a Linux lane cannot reach: on a platform WITHOUT
			// /proc the handle is the only ownership evidence, so passing it at
			// this site would refuse the group kill whenever the direct child had
			// already died — and `processExiting` deliberately skips the exited
			// early return precisely so an already-dead child can still have its
			// GROUP reaped (#2026). `killPosixProcessGroup` therefore does not
			// pass the handle; `killWindowsTree` still does, because a recycled
			// Windows pid under `taskkill /F /T` is what that check exists for.
			const proc = {
				kill: vi.fn(() => true),
				unref: vi.fn(),
				exitCode: 0,
				once: vi.fn(),
				off: vi.fn(),
			};
			await killProcessTree(proc, 4242, {
				fast: true,
				processExiting: true,
			});

			expect(processKillSpy).toHaveBeenCalledWith(-4242, "SIGTERM");
		});

		it("never negates a non-positive pid into a group kill (guards process.kill(-0))", async () => {
			// process.kill(-0, sig) would signal pi-lens's OWN process group.
			// The pid<=0 guard must skip the group path entirely and only touch
			// the child handle.
			const proc = { kill: vi.fn(() => true), unref: vi.fn() };
			await killProcessTree(proc, 0, { fast: true });

			expect(processKillSpy).not.toHaveBeenCalled();
			expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
		});

		it("non-fast shutdown escalates SIGTERM → SIGKILL on the process group", async () => {
			// #1114 follow-up: this mock must be `once`-capable so the
			// escalation logic's real gate (an observed "exit" event, not the
			// unreachable `proc.killed` send-flag) is actually exercised —
			// without `.once`, `proc.once?.(...)` optional-chains to a no-op
			// and the "exited" flag can never be set from true code changes,
			// making the assertions below pass vacuously regardless of
			// whether the escalation logic is correct.
			const proc = {
				kill: vi.fn(() => true),
				unref: vi.fn(),
				once: vi.fn(),
				off: vi.fn(),
			};
			const done = killProcessTree(proc, 4242, {});

			expect(processKillSpy).toHaveBeenCalledWith(-4242, "SIGTERM");
			expect(processKillSpy).not.toHaveBeenCalledWith(-4242, "SIGKILL");

			await vi.advanceTimersByTimeAsync(1500);
			await done;

			expect(processKillSpy).toHaveBeenCalledWith(-4242, "SIGKILL");
		});

		// #1114 follow-up (adversarial review of PR #1130): the pre-existing
		// tests above use mocks that lack `.once`/never set `.killed`, so both
		// the pre-fix `!proc.killed` guard AND the post-fix `!exited` guard
		// were vacuously permissive there — neither test could actually catch
		// a regression in the escalation logic. These two tests use an
		// `.once`-capable mock that captures the real "exit" listener the fix
		// registers, and assert BOTH directions of the `fast`-shutdown
		// escalation timer (client.ts's `killProcessTree`, `options.fast`
		// branch): no premature SIGKILL when the process is observed to exit
		// within the window, and a real SIGKILL when it isn't.
		it("fast shutdown SIGKILLs the process group when no exit is observed by the 1.5s window", async () => {
			const proc = {
				kill: vi.fn(() => true),
				unref: vi.fn(),
				once: vi.fn(),
				off: vi.fn(),
			};
			await killProcessTree(proc, 4242, { fast: true });

			expect(processKillSpy).toHaveBeenCalledWith(-4242, "SIGTERM");
			expect(processKillSpy).not.toHaveBeenCalledWith(-4242, "SIGKILL");

			await vi.advanceTimersByTimeAsync(1500);

			expect(processKillSpy).toHaveBeenCalledWith(-4242, "SIGKILL");
		});

		it("fast shutdown skips the group SIGKILL when the process's exit is observed before the 1.5s window", async () => {
			let exitListener: (() => void) | undefined;
			const proc = {
				kill: vi.fn(() => true),
				unref: vi.fn(),
				once: vi.fn((event: string, listener: () => void) => {
					if (event === "exit") exitListener = listener;
				}),
				off: vi.fn(),
			};
			await killProcessTree(proc, 4242, { fast: true });

			expect(processKillSpy).toHaveBeenCalledWith(-4242, "SIGTERM");
			expect(exitListener).toBeDefined();

			// The process dies well inside the escalation window.
			exitListener?.();
			await vi.advanceTimersByTimeAsync(1500);

			expect(processKillSpy).not.toHaveBeenCalledWith(-4242, "SIGKILL");
		});

		it("resolves on the process's exit event without waiting out the escalation window", async () => {
			// A graceful shutdown (server honored `exit`) used to still sleep the
			// full 1500ms before checking whether to SIGKILL — every LSP teardown
			// paid the window even when the process was already dead.
			let exitListener: (() => void) | undefined;
			const proc = {
				kill: vi.fn(() => true),
				unref: vi.fn(),
				once: vi.fn((event: string, listener: () => void) => {
					if (event === "exit") exitListener = listener;
				}),
				off: vi.fn(),
			};
			const done = killProcessTree(proc, 4242, {});

			expect(processKillSpy).toHaveBeenCalledWith(-4242, "SIGTERM");
			expect(exitListener).toBeDefined();
			exitListener?.();
			// No timer advance: with fake timers active, resolution proves the
			// exit event settled the wait, not the 1500ms escalation timer.
			await done;

			expect(processKillSpy).not.toHaveBeenCalledWith(-4242, "SIGKILL");
		});
	});
});
