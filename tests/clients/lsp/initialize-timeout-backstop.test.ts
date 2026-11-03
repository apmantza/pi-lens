// flake-shape: real-process-spawn — the SIGKILL backstop races killProcessTree's SIGTERM over a real process group; a stub has no group to signal
/**
 * #1114 follow-up (adversarial review of PR #1130) — the `initialize()`-timeout
 * catch block in `createLSPClient` (clients/lsp/client.ts) has a 2s SIGKILL
 * backstop that was completely untested. Pre-fix it read
 * `if (!lspProcess.process.killed && ...)`: `killProcessTree` called just above
 * it only ever signals the POSIX process GROUP via the raw
 * `process.kill(-pid, …)` syscall (never the `ChildProcess#kill()` method), so
 * `lspProcess.process.killed` never flips true — the guard was always-true and
 * the backstop unconditionally re-sent `SIGKILL` to the (by then already-dead)
 * process handle 2 seconds later, regardless of whether it had already exited.
 * `ChildProcess#kill()` on an already-exited handle is a harmless no-op (it
 * doesn't throw), so this never crashed anything — but it IS the same
 * always-true-guard defect shape as the safe-spawn escalation bug, just with a
 * harmless rather than a silent-failure consequence.
 *
 * This test uses a REAL child process (the fake LSP server fixture, same
 * pattern as teardown-logging.test.ts) with `FAKE_LSP_IGNORE_INITIALIZE=1` so
 * the handshake never completes and `initializeTimeoutMs` fires quickly. The
 * fixture does not ignore SIGTERM, so `killProcessTree`'s real SIGTERM
 * (routed through the process GROUP, since `launchLSP` detaches the child on
 * POSIX) terminates it well within both killProcessTree's own 1.5s escalation
 * window and this backstop's 2s window — giving a real, observable
 * "already exited by the time the backstop fires" case. Post-fix (gate on
 * `exitCode`/`signalCode` both being null — the P3-1 precision fix from the
 * same review round, since a signal-killed process has `exitCode === null`
 * forever and only `signalCode` set), the backstop must NOT call
 * `kill("SIGKILL")` again. Pre-fix, it always did.
 *
 * POSIX-only (killProcessTree's Windows branch is architecturally different —
 * `taskkill /F /T`, not signal-based — and is covered by
 * tests/clients/lsp/kill-process-tree.test.ts instead).
 */

import { describe, expect, it, vi } from "vitest";
import { spawnFakeLspServer } from "../../support/fake-lsp-server.js";

const describeOrSkip = process.platform === "win32" ? describe.skip : describe;

describeOrSkip(
	"createLSPClient — initialize-timeout 2s SIGKILL backstop (#1114)",
	() => {
		it("does not re-send SIGKILL once killProcessTree's own SIGTERM has already ended the process", async () => {
			const { createLSPClient } =
				await import("../../../clients/lsp/client.js");

			const proc = await spawnFakeLspServer({
				cwd: process.cwd(),
				env: { ...process.env, FAKE_LSP_IGNORE_INITIALIZE: "1" },
			});
			const killSpy = vi.spyOn(proc.process, "kill");

			await expect(
				createLSPClient({
					serverId: "fake-init-hang",
					process: proc,
					root: process.cwd(),
					initializeTimeoutMs: 50,
				}),
			).rejects.toThrow();

			// Wait past BOTH killProcessTree's own 1.5s non-fast escalation
			// window and this backstop's 2s window. The real (non-ignoring)
			// fake server dies from the initial SIGTERM well under either.
			await new Promise((resolve) => setTimeout(resolve, 2500));

			expect(
				proc.process.exitCode !== null || proc.process.signalCode !== null,
			).toBe(true);
			// The core assertion: no redundant SIGKILL once death was already
			// observed. Pre-fix (`!lspProcess.process.killed`), this always
			// fired regardless.
			expect(killSpy).not.toHaveBeenCalledWith("SIGKILL");
		}, 8_000);
	},
);
