// flake-shape: real-process-spawn — Real child transport and lifecycle are the subject; a process stub cannot exercise the wire and teardown behavior.
/**
 * #1620 residual — clientShutdown against a REAL wedged child process.
 *
 * `shutdown-wedged-connection.test.ts` proves the bound with a connection
 * double whose sends never settle. That is the right tool for asserting the
 * exact log fields, but it sidesteps the actual mechanism: a real OS pipe
 * only stops accepting writes once its buffer is exhausted, so a genuine
 * "stdin not draining" server needs enough unread traffic ahead of the
 * write, not just an unresponsive peer. This file closes that gap with the
 * real `tests/fixtures/fake-lsp-server.mjs` child process.
 *
 * The fixture's `FAKE_LSP_WEDGE_STDIN_AFTER_INIT=1` mode pauses its stdin
 * for good right after the `initialized` handshake notification. The test
 * then fires three ~4MB (~12MB total) padding `didOpen` writes (unawaited —
 * those writes never settle either) to exhaust the OS pipe buffer, confirmed
 * against a throwaway probe: a single small write past ~1-2MB of unread
 * backlog stops invoking its callback entirely. Only then does
 * clientShutdown's own "shutdown" request and "exit" notification writes
 * race the same wedge.
 *
 * Red-first: reverting #1624's try/finally (restoring the bare unbounded
 * `await safeSendNotification(connection, "exit", {})`) makes this hang to
 * the per-test timeout. See the PR body for the captured red run.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logLatency } from "../../../clients/latency-logger.js";
import { spawnFakeLspServer } from "../../support/fake-lsp-server.js";

// Keep both budgets short so the wedge is bounded well inside the per-test
// timeout, same pattern as shutdown-wedged-connection.test.ts. Assigned
// before any dynamic `client.js` import below, so the module-load-time env
// reads see these values.
process.env.PI_LENS_LSP_SHUTDOWN_TIMEOUT_MS = "300";
process.env.PI_LENS_LSP_EXIT_NOTIFY_TIMEOUT_MS = "300";

vi.mock("../../../clients/latency-logger.js", async (importActual) => ({
	...(await importActual<
		typeof import("../../../clients/latency-logger.js")
	>()),
	logLatency: vi.fn(),
}));

// Comfortably past what a throwaway probe measured as sufficient (~1-2MB) to
// exhaust an anonymous pipe's OS buffer on both Windows and Linux CI.
const PADDING_BYTES = 4 * 1024 * 1024;

describe("clientShutdown against a real wedged child process (#1620)", () => {
	let client:
		| Awaited<
				ReturnType<
					typeof import("../../../clients/lsp/client.js").createLSPClient
				>
		  >
		| undefined;

	beforeEach(() => {
		vi.mocked(logLatency).mockReset();
	});

	afterEach(async () => {
		if (client) {
			try {
				await client.shutdown();
			} catch {
				/* ignore — already torn down by the test body in the common case */
			}
			client = undefined;
		}
	});

	it("settles within the shutdown budget, kills the pid, and deregisters it", async () => {
		const { createLSPClient } = await import("../../../clients/lsp/client.js");
		const { removeLspChild } =
			await import("../../../clients/instance-registry.js");
		const removeSpy = vi.spyOn(
			await import("../../../clients/instance-registry.js"),
			"removeLspChild",
		);

		const proc = await spawnFakeLspServer({
			cwd: process.cwd(),
			env: { ...process.env, FAKE_LSP_WEDGE_STDIN_AFTER_INIT: "1" },
		});

		client = await createLSPClient({
			serverId: "wedged-live",
			process: proc,
			root: process.cwd(),
		});
		const pid = proc.pid;
		expect(typeof pid).toBe("number");

		// Pad the (now-paused) stdin pipe past its OS buffer before shutting
		// down. Unawaited on purpose — these writes never settle once the
		// buffer is exhausted, same as the "exit" notify clientShutdown is
		// about to attempt.
		const padding = "x".repeat(PADDING_BYTES);
		for (let i = 0; i < 3; i++) {
			void client.notify
				.open(`/pad-${i}.txt`, padding, "plaintext", false, true)
				.catch(() => {});
		}
		// Let the padding writes actually reach the OS layer before racing
		// clientShutdown against them.
		await new Promise((resolve) => setTimeout(resolve, 50));

		const start = Date.now();
		await client.shutdown();
		const elapsed = Date.now() - start;
		client = undefined;

		// Budget is 300ms for each of the two handshake writes (600ms worst
		// case) plus killProcessTree's own bounded wait — generous slack, but
		// still proves this is bounded rather than hanging on the wedge.
		expect(elapsed).toBeLessThan(5_000);
		// A floor, not just a ceiling: if the fixture's wedge were a no-op (the
		// child exiting early instead of staying wedged — exactly the failure
		// mode a throwaway probe caught during development, where writes to an
		// already-dead child fail FAST with EPIPE rather than genuinely
		// hanging), this run would finish near-instantly and the ceiling check
		// above would pass for the wrong reason. At least one of the two
		// handshake writes must actually have run out its budget.
		expect(elapsed).toBeGreaterThanOrEqual(280);

		expect(removeSpy).toHaveBeenCalledWith(pid, undefined);

		// Same "prove the wedge was real, not a fast failure" concern, from the
		// teardown's own record: a dead-child EPIPE would show up as
		// *Undelivered, not *TimedOut (residual 1 / F2's distinction) — this
		// run must show the timer actually winning the race.
		const hit = vi
			.mocked(logLatency)
			.mock.calls.find(([e]) => e?.phase === "lsp_client_shutdown");
		expect(hit).toBeDefined();
		const meta = hit![0].metadata!;
		expect(meta.exitNotifyTimedOut).toBe(true);
		expect(meta.shutdownOutcome).toBe("forced");

		// The real child must actually be gone, not just marked so — poll
		// briefly since killProcessTree's own signal delivery is async.
		const deadline = Date.now() + 3_000;
		let alive = true;
		while (Date.now() < deadline) {
			try {
				process.kill(pid!, 0);
			} catch {
				alive = false;
				break;
			}
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		expect(
			alive,
			`pid ${pid} must not still be alive after clientShutdown`,
		).toBe(false);

		removeSpy.mockRestore();
		void removeLspChild;
	}, 15_000);
});
