import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPiMock, makeCtx } from "../../support/pi-mock.js";
import { makeLspServiceDouble } from "../../support/lsp-service-double.js";

const dispatchResult = {
	diagnostics: [{ tool: "dispatch", message: "dispatch fired" }],
	blockers: [],
	warnings: [],
	baselineWarningCount: 0,
	fixed: [],
	resolvedCount: 0,
	output: "dispatch output",
	blockerOutput: "",
	hasBlockers: false,
};

describe("dispatch session warm/first-use liveness (#1394)", () => {
	afterEach(() => vi.resetModules());

	it("session_start -> edit tool_result produces dispatch output", async () => {
		vi.resetModules();
		vi.doMock(
			"../../../clients/dispatch/integration.js",
			async (importOriginal) => ({
				...(await importOriginal<
					typeof import("../../../clients/dispatch/integration.js")
				>()),
				dispatchLintWithResult: async () => dispatchResult,
			}),
		);
		vi.doMock("../../../clients/bootstrap.js", async () => {
			const { bootstrapSeamMock } =
				await import("../../support/bootstrap-mock.js");
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
		vi.doMock("../../../clients/lsp/index.js", () => ({
			getLSPService: () =>
				makeLspServiceDouble({
					touchFile: async () => [],
					supportsLSP: () => false,
					getStatus: () => [],
					getAliveServerIds: () => [],
				}),
			resetLSPService: () => {},
		}));
		const { default: registerExtension } = await import("../../../index.js");
		const pi = createPiMock({ "no-lsp": true, "no-autoformat": true });
		registerExtension(pi.asExtensionAPI());
		const cwd = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-dispatch-live-"),
		);
		const filePath = path.join(cwd, "src", "live.ts");
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
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

			expect(JSON.stringify(result)).toContain("dispatch output");
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	}, 30_000);
});
