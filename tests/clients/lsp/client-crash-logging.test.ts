// flake-shape: real-process-spawn — a child that dies unprompted must emit a real exit signal and close event; a stub never exits on its own
/**
 * #615-followup dogfooding: an ast-grep client died 5 times mid-sweep in a real
 * project and NOTHING in latency.log recorded why — no exit code, no signal,
 * no stderr. Root cause: the `lsp_server_unexpected_exit` log in
 * `setupConnectionLifecycle` (client.ts) was gated on `wasConnected`, captured
 * at the moment the process `exit` event fires. For a crash where the JSON-RPC
 * transport tears down first (`connection.onClose`/`onError`, which already
 * flip `isConnected` to false and run synchronously off the closing stdio
 * pipe), that flag is already false by the time `exit` fires — so the log
 * silently never ran, indistinguishable from an intentional `shutdown()`.
 *
 * The fix swaps the gate to an explicit `state.shutdownRequested` flag set
 * ONLY by `clientShutdown()`, and adds the exit signal + a stderr tail to the
 * log. This test kills the fake server's real child process out from under a
 * live client (no `shutdown()` call first) and confirms the crash IS logged
 * with a real exit code/signal — the exact case that went dark before.
 */

import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logLatency } from "../../../clients/latency-logger.js";
import { spawnFakeLspServer } from "../../support/fake-lsp-server.js";

vi.mock("../../../clients/latency-logger.js", async (importActual) => ({
	...(await importActual<
		typeof import("../../../clients/latency-logger.js")
	>()),
	logLatency: vi.fn(),
}));

describe("LSP client — crash exit is logged, not silently swallowed", () => {
	let client:
		| Awaited<
				ReturnType<
					typeof import("../../../clients/lsp/client.js").createLSPClient
				>
		  >
		| undefined;
	let proc: Awaited<ReturnType<typeof spawnFakeLspServer>> | undefined;

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

	it("logs lsp_server_unexpected_exit with a real exit signal when the child dies unprompted", async () => {
		const { createLSPClient } = await import("../../../clients/lsp/client.js");
		proc = await spawnFakeLspServer({ cwd: process.cwd() });
		client = await createLSPClient({
			serverId: "fake",
			process: proc,
			root: process.cwd(),
		});
		expect(client.isAlive()).toBe(true);

		// Kill the real child directly — no clientShutdown() call, so
		// shutdownRequested stays false, mirroring a genuine crash (not us
		// intentionally tearing the client down).
		proc.process.kill("SIGKILL");

		await vi.waitFor(() => {
			const calls = (logLatency as ReturnType<typeof vi.fn>).mock.calls;
			const hit = calls.find(
				([entry]) => entry?.phase === "lsp_server_unexpected_exit",
			);
			expect(hit).toBeDefined();
		});

		const calls = (logLatency as ReturnType<typeof vi.fn>).mock.calls;
		const [entry] = calls.find(
			([e]) => e?.phase === "lsp_server_unexpected_exit",
		)!;
		expect(entry.metadata.serverId).toBe("fake");
		expect(entry.metadata.exitSignal).toBe("SIGKILL");
		expect(typeof entry.metadata.stderrTail).toBe("string");
	}, 10_000);

	it("does NOT log lsp_server_unexpected_exit for an intentional shutdown()", async () => {
		const { createLSPClient } = await import("../../../clients/lsp/client.js");
		proc = await spawnFakeLspServer({ cwd: process.cwd() });
		client = await createLSPClient({
			serverId: "fake",
			process: proc,
			root: process.cwd(),
		});

		await client.shutdown();
		client = undefined;

		// Give the process a moment to actually exit and its 'exit' handler to run.
		await new Promise((resolve) => setTimeout(resolve, 300));

		const calls = (logLatency as ReturnType<typeof vi.fn>).mock.calls;
		const hit = calls.find(
			([entry]) => entry?.phase === "lsp_server_unexpected_exit",
		);
		expect(hit).toBeUndefined();
	}, 10_000);

	it("closeDocument sends didClose and clears document lifecycle state", async () => {
		const { createLSPClient } = await import("../../../clients/lsp/client.js");
		const filePath = path.join(process.cwd(), "client-close-document.ts");
		const fileUri = pathToFileURL(filePath).href;

		proc = await spawnFakeLspServer({ cwd: process.cwd() });
		client = await createLSPClient({
			serverId: "fake",
			process: proc,
			root: process.cwd(),
		});
		const sendNotification = vi.spyOn(client.connection, "sendNotification");

		await client.notify.open(
			filePath,
			"const broken = true;",
			"typescript",
			false,
			true,
		);
		await client.notify.change(filePath, "const changed = true;");
		await client.waitForDiagnostics(filePath, 1_000, { pullOnly: true });
		expect(client.isDocumentOpen(filePath)).toBe(true);
		expect(client.getDiagnostics(filePath)).toHaveLength(1);
		expect(client.getTrackedDiagnosticPaths()).toContain(filePath);

		await client.closeDocument(filePath);

		expect(sendNotification).toHaveBeenCalledWith("textDocument/didClose", {
			textDocument: { uri: fileUri },
		});
		expect(client.isDocumentOpen(filePath)).toBe(false);
		expect(client.getDiagnostics(filePath)).toEqual([]);
		expect(client.getTrackedDiagnosticPaths()).not.toContain(filePath);

		await client.notify.open(
			filePath,
			"const reopened = true;",
			"typescript",
			false,
			true,
		);
		const reopenCalls = sendNotification.mock.calls.filter(
			([method]) => method === "textDocument/didOpen",
		);
		const reopen = reopenCalls[reopenCalls.length - 1];
		expect(reopen?.[1]).toMatchObject({
			textDocument: { uri: fileUri, version: 0 },
		});

		await client.closeDocument(filePath);
		const closeCount = sendNotification.mock.calls.filter(
			([method]) => method === "textDocument/didClose",
		).length;
		await client.closeDocument(filePath);
		expect(
			sendNotification.mock.calls.filter(
				([method]) => method === "textDocument/didClose",
			).length,
		).toBe(closeCount);
	}, 10_000);
});
