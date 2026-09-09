import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPiMock, makeCtx } from "../support/pi-mock.js";
import { makeLspServiceDouble } from "../support/lsp-service-double.js";
import { removeTempDirSync } from "./test-utils.js";

describe("LSP session warm/first-use liveness (#1394)", () => {
	afterEach(() => vi.resetModules());

	it("session_start -> first edit services the LSP and produces pipeline output", async () => {
		vi.resetModules();
		const touchFile = vi.fn(async () => []);
		const service = makeLspServiceDouble({
			touchFile,
			supportsLSP: () => true,
		});
		vi.doMock("../../clients/lsp/index.js", () => ({
			getLSPService: () => service,
			resetLSPService: () => {},
		}));
		vi.doMock(
			"../../clients/dispatch/integration.js",
			async (importOriginal) => ({
				...(await importOriginal<
					typeof import("../../clients/dispatch/integration.js")
				>()),
				dispatchLintWithResult: async () => ({
					diagnostics: [],
					blockers: [],
					warnings: [],
					baselineWarningCount: 0,
					fixed: [],
					resolvedCount: 0,
					output: "lsp pipeline output",
					blockerOutput: "",
					hasBlockers: false,
				}),
			}),
		);
		vi.doMock("../../clients/bootstrap.js", async () => {
			const { bootstrapSeamMock } =
				await import("../support/bootstrap-mock.js");
			return bootstrapSeamMock(async () => ({
				metricsClient: { reset: () => {} },
				todoScanner: {},
				biomeClient: { isAvailable: () => false, isSupportedFile: () => false },
				ruffClient: { isAvailable: () => false, isSupportedFile: () => false },
				knipClient: {
					isAvailable: () => false,
					analyze: async () => ({ issues: [] }),
				},
				jscpdClient: { isAvailable: () => false },
				depChecker: { isAvailable: () => false },
				testRunnerClient: { detectRunner: () => null },
				goClient: { isGoAvailableAsync: async () => false },
				rustClient: { isAvailableAsync: async () => false },
				agentBehaviorClient: {
					recordToolCall: () => [],
					formatWarnings: () => "",
				},
				complexityClient: {
					isSupportedFile: () => false,
					analyzeFile: () => null,
				},
			}));
		});
		const { default: registerExtension } = await import("../../index.js");
		const pi = createPiMock({ "no-autoformat": true });
		registerExtension(pi.asExtensionAPI());
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-lsp-live-"));
		const filePath = path.join(cwd, "live.ts");
		fs.writeFileSync(filePath, "export const live = 1;\n");
		try {
			await pi.emit("session_start", {}, makeCtx({ cwd }));
			await pi.emit("turn_start", {}, makeCtx({ cwd }));
			const result = await pi.emit(
				"tool_result",
				{
					toolName: "edit",
					input: { path: filePath },
					details: { diff: "+ 1 export const live = 2;" },
					content: [{ type: "text", text: "ok" }],
				},
				makeCtx({ cwd }),
			);
			expect(touchFile).toHaveBeenCalled();
			expect(JSON.stringify(result)).toContain("lsp pipeline output");
		} finally {
			removeTempDirSync(cwd);
		}
	}, 30_000);
});
