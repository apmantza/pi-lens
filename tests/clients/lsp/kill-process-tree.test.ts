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

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.fn((..._args: unknown[]) => ({
	once: vi.fn(),
	unref: vi.fn(),
}));
vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return { ...actual, spawn: spawnMock };
});

const { killProcessTree } = await import("../../../clients/lsp/client.js");

describe("killProcessTree", () => {
	const realPlatform = process.platform;
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

		it("non-exiting fast shutdown still spawns the taskkill /T tree-kill", async () => {
			const proc = { kill: vi.fn(() => true), unref: vi.fn() };
			await killProcessTree(proc, 4242, { fast: true });
			expect(spawnMock).toHaveBeenCalledTimes(1);
			const call = spawnMock.mock.calls[0];
			expect(String(call[0]).toLowerCase()).toContain("taskkill");
			expect(call[1]).toEqual(expect.arrayContaining(["/T", "/PID", "4242"]));
		});
	});

	describe("POSIX process-group teardown", () => {
		beforeEach(() => {
			spawnMock.mockClear();
			Object.defineProperty(process, "platform", {
				value: "linux",
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
			const proc = { kill: vi.fn(() => true), unref: vi.fn() };
			const done = killProcessTree(proc, 4242, {});

			expect(processKillSpy).toHaveBeenCalledWith(-4242, "SIGTERM");
			expect(processKillSpy).not.toHaveBeenCalledWith(-4242, "SIGKILL");

			await vi.advanceTimersByTimeAsync(1500);
			await done;

			expect(processKillSpy).toHaveBeenCalledWith(-4242, "SIGKILL");
		});
	});
});
