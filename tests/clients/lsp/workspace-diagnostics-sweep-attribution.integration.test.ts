/**
 * #2332: exercise the #2272 sweep bracket through a real JSON-RPC connection.
 * The fake server is programmable, but client creation, framing, capability
 * negotiation, workspace pull, fallback touch, and the sweep are production code.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { waitFor } from "../interleaving-kit.js";
import { spawnFakeLspServer } from "../../support/fake-lsp-server.js";
import { removeTempDirSync } from "../test-utils.js";

const getServersForFileWithConfig = vi.fn();

vi.mock("../../../clients/lsp/config.js", () => ({
	getServersForFileWithConfig,
	getServerInitOverride: vi.fn().mockReturnValue(undefined),
}));

describe("runWorkspaceDiagnostics sweep bracket on the real wire (#2332)", () => {
	let root: string;
	let file: string;
	let traceFile: string;
	let service: import("../../../clients/lsp/index.js").LSPService | undefined;

	beforeEach(async () => {
		vi.resetModules();
		getServersForFileWithConfig.mockReset();
		root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-wsd-2332-"));
		fs.mkdirSync(path.join(root, ".pi-lens"));
		file = path.join(root, "subject.ts");
		traceFile = path.join(root, "wire.trace");
		fs.writeFileSync(file, "export const subject = 1;\n");
		process.env.PI_LENS_LSP_WORKSPACE_PULL = "1";

		getServersForFileWithConfig.mockReturnValue([
			{
				id: "typescript",
				name: "typescript",
				extensions: [".ts"],
				idleEviction: "resident",
				root: async () => root,
				spawn: async () => ({
					process: await spawnFakeLspServer({
						cwd: root,
						env: {
							...process.env,
							FAKE_LSP_TRACE_FILE: traceFile,
							FAKE_LSP_WORKSPACE_DIAGNOSTICS: "1",
							FAKE_LSP_WORKSPACE_DIAGNOSTIC_URI: pathToFileURL(file).href,
						},
					}),
					source: "test" as const,
				}),
			},
		]);

		const roots = await import("../../../clients/lsp/session-roots.js");
		roots.resetSessionRootsForTests();
		roots.registerSessionRoot(root);
		const latency = await import("../../../clients/latency-logger.js");
		latency.resetCurrentPhaseForSession();
	});

	afterEach(async () => {
		delete process.env.PI_LENS_LSP_WORKSPACE_PULL;
		delete process.env.FAKE_LSP_WORKSPACE_DIAGNOSTIC_ERROR;
		delete process.env.FAKE_LSP_WORKSPACE_DIAGNOSTIC_DELAY_MS;
		await service?.shutdown({ reason: "test" });
		const roots = await import("../../../clients/lsp/session-roots.js");
		roots.resetSessionRootsForTests();
		removeTempDirSync(root);
		vi.restoreAllMocks();
	});

	it("opens one attributable phase pair for one real workspace pull sweep", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const latency = await import("../../../clients/latency-logger.js");
		service = new LSPService();

		// Keep the real child request open long enough to observe the live bracket.
		process.env.FAKE_LSP_WORKSPACE_DIAGNOSTIC_DELAY_MS = "250";
		const startedAt = Date.now();
		const sweep = service.runWorkspaceDiagnostics(root, { files: [file] });
		await waitFor(
			() =>
				fs.existsSync(traceFile) ? fs.readFileSync(traceFile, "utf8") : "",
			(trace) => trace.includes("recv workspace/diagnostic"),
		);
		expect(latency.getCurrentPhase()?.phase).toBe(
			"lsp_workspace_diagnostics_touch",
		);

		const results = await sweep;
		const finishedAt = Date.now();
		expect(results).toHaveLength(1);
		expect(results[0]?.timedOut).toBe(false);
		expect(latency.getCurrentPhase()).toBeUndefined();
		expect(latency._closedBracketsStorageLengthForTest()).toBe(1);
		expect(latency.getPhaseForWindow(startedAt, finishedAt)?.phase).toBe(
			"lsp_workspace_diagnostics_touch",
		);
	}, 30_000);

	it("continues on the real document pull when the workspace pull rejects", async () => {
		process.env.FAKE_LSP_WORKSPACE_DIAGNOSTIC_ERROR = "1";
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const latency = await import("../../../clients/latency-logger.js");
		service = new LSPService();

		const results = await service.runWorkspaceDiagnostics(root, {
			files: [file],
		});
		const trace = fs.readFileSync(traceFile, "utf8");
		expect(trace).toContain("recv workspace/diagnostic");
		// The rejected project pull falls back to the real document pull.
		expect(trace).toContain("recv textDocument/diagnostic");
		expect(results).toHaveLength(1);
		expect(latency.getCurrentPhase()).toBeUndefined();
		expect(latency._closedBracketsStorageLengthForTest()).toBe(1);
	}, 30_000);

	it("closes the phase when warm-up throws out of the server-group runner", async () => {
		process.env.FAKE_LSP_WORKSPACE_DIAGNOSTIC_ERROR = "1";
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const latency = await import("../../../clients/latency-logger.js");
		service = new LSPService();
		const escapedError = new Error("fake escaping warm-up failure");
		vi.spyOn(service, "ensureWarmForSweep").mockRejectedValueOnce(escapedError);

		await expect(
			service.runWorkspaceDiagnostics(root, { files: [file] }),
		).rejects.toBe(escapedError);
		const trace = fs.readFileSync(traceFile, "utf8");
		// The real-wire pull error is absorbed before the warm-up rejection escapes.
		expect(trace).toContain("recv workspace/diagnostic");
		expect(latency.getCurrentPhase()).toBeUndefined();
		expect(latency._closedBracketsStorageLengthForTest()).toBe(1);
	}, 30_000);
});
