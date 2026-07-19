/**
 * #708 — LSP teardown logging
 *
 * Verifies that the four new latency phases are written during LSP teardown:
 *   (a) lsp_service_reset  — produced by LSPService.shutdown() with reason + aliveClients
 *   (b) lsp_client_shutdown — produced by clientShutdown() with shutdownRequestTimedOut
 *
 * lsp_registry_write_failed and lsp_kill_escalation are fire-and-forget / platform-
 * specific paths; they are exercised via unit-level assertions on the catch handlers
 * rather than live-process integration tests (those would require a real filesystem
 * fault or POSIX SIGTERM + 1500ms real wait).
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logLatency } from "../../../clients/latency-logger.js";

vi.mock("../../../clients/latency-logger.js", () => ({ logLatency: vi.fn() }));

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FAKE_SERVER_PATH = path.join(
	__dirname,
	"../../fixtures/fake-lsp-server.mjs",
);

// ---------------------------------------------------------------------------
// (a) lsp_service_reset — LSPService.shutdown()
// ---------------------------------------------------------------------------
describe("LSPService.shutdown() — lsp_service_reset phase", () => {
	beforeEach(() => {
		(logLatency as ReturnType<typeof vi.fn>).mockReset();
	});

	it("writes lsp_service_reset with reason and aliveClients=0 when no clients are alive", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const svc = new LSPService();
		await svc.shutdown({ reason: "session_start", fast: true });

		const calls = (logLatency as ReturnType<typeof vi.fn>).mock.calls;
		const hit = calls.find(([e]) => e?.phase === "lsp_service_reset");
		expect(hit).toBeDefined();
		const [entry] = hit!;
		expect(entry.metadata.reason).toBe("session_start");
		expect(entry.metadata.aliveClients).toBe(0);
		expect(entry.metadata.fast).toBe(true);
		expect(entry.metadata.processExiting).toBe(false);
	});

	it("writes lsp_service_reset with reason=null when no reason is supplied", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const svc = new LSPService();
		await svc.shutdown({ fast: true });

		const calls = (logLatency as ReturnType<typeof vi.fn>).mock.calls;
		const hit = calls.find(([e]) => e?.phase === "lsp_service_reset");
		expect(hit).toBeDefined();
		const [entry] = hit!;
		expect(entry.metadata.reason).toBeNull();
	});

	it("writes lsp_service_reset with processExiting=true when processExiting is set", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const svc = new LSPService();
		await svc.shutdown({ reason: "session_shutdown", fast: true, processExiting: true });

		const calls = (logLatency as ReturnType<typeof vi.fn>).mock.calls;
		const hit = calls.find(([e]) => e?.phase === "lsp_service_reset");
		expect(hit).toBeDefined();
		const [entry] = hit!;
		expect(entry.metadata.reason).toBe("session_shutdown");
		expect(entry.metadata.processExiting).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// (b) lsp_client_shutdown — clientShutdown()
// ---------------------------------------------------------------------------
describe("clientShutdown() — lsp_client_shutdown phase", () => {
	let client:
		| Awaited<
				ReturnType<
					typeof import("../../../clients/lsp/client.js").createLSPClient
				>
		  >
		| undefined;
	let proc:
		| Awaited<
				ReturnType<typeof import("../../../clients/lsp/launch.js").launchLSP>
		  >
		| undefined;

	beforeEach(() => {
		(logLatency as ReturnType<typeof vi.fn>).mockReset();
	});

	afterEach(async () => {
		if (client) {
			try {
				await client.shutdown();
			} catch {
				/* ignore */
			}
			client = undefined;
		}
		proc = undefined;
	});

	it("writes lsp_client_shutdown with shutdownRequestTimedOut=false on clean shutdown", async () => {
		const { createLSPClient } = await import("../../../clients/lsp/client.js");
		const { launchLSP } = await import("../../../clients/lsp/launch.js");

		proc = await launchLSP(process.execPath, [FAKE_SERVER_PATH], {
			cwd: process.cwd(),
		});
		client = await createLSPClient({
			serverId: "fake",
			process: proc,
			root: process.cwd(),
		});

		await client.shutdown();
		client = undefined;

		const calls = (logLatency as ReturnType<typeof vi.fn>).mock.calls;
		const hit = calls.find(([e]) => e?.phase === "lsp_client_shutdown");
		expect(hit).toBeDefined();
		const [entry] = hit!;
		expect(entry.metadata.serverId).toBe("fake");
		expect(typeof entry.metadata.pid).toBe("number");
		expect(entry.metadata.fast).toBe(false);
		expect(entry.metadata.processExiting).toBe(false);
		expect(entry.metadata.shutdownRequestTimedOut).toBe(false);
		expect(typeof entry.durationMs).toBe("number");
	}, 15_000);

	it("writes lsp_client_shutdown with shutdownRequestTimedOut=true when the graceful shutdown request hangs", async () => {
		// The fake server respects FAKE_LSP_IGNORE_SHUTDOWN=1 to simulate a
		// server that never replies to the "shutdown" request — the withTimeout()
		// in clientShutdown will fire after SHUTDOWN_REQUEST_TIMEOUT_MS and set
		// shutdownRequestTimedOut=true in the log entry.
		const { createLSPClient } = await import("../../../clients/lsp/client.js");
		const { launchLSP } = await import("../../../clients/lsp/launch.js");

		proc = await launchLSP(process.execPath, [FAKE_SERVER_PATH], {
			cwd: process.cwd(),
			env: { ...process.env, FAKE_LSP_IGNORE_SHUTDOWN: "1" },
		});

		client = await createLSPClient({
			serverId: "fake-hang",
			process: proc,
			root: process.cwd(),
		});

		// shutdown() sends the "shutdown" request; the fake server ignores it, so
		// SHUTDOWN_REQUEST_TIMEOUT_MS (300ms in client.ts) fires and the catch
		// sets shutdownRequestTimedOut=true before calling killProcessTree.
		await client.shutdown();
		client = undefined;

		const calls = (logLatency as ReturnType<typeof vi.fn>).mock.calls;
		const hit = calls.find(([e]) => e?.phase === "lsp_client_shutdown");
		expect(hit).toBeDefined();
		const [entry] = hit!;
		expect(entry.metadata.shutdownRequestTimedOut).toBe(true);
		expect(entry.metadata.serverId).toBe("fake-hang");
	}, 20_000);
});
