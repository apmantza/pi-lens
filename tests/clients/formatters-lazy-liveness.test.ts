import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPiMock, makeCtx } from "../support/pi-mock.js";
import { makeLspServiceDouble } from "../support/lsp-service-double.js";

describe("formatter session warm/first-use liveness (#1394)", () => {
	afterEach(() => vi.resetModules());

	it("session_start -> immediate format edit actually changes the file", async () => {
		vi.resetModules();
		vi.doMock("../../clients/formatters.js", async (importOriginal) => ({
			...(await importOriginal<typeof import("../../clients/formatters.js")>()),
			getFormattersForFile: async () => [
				{ name: "test-formatter", command: ["test-formatter"] },
			],
			formatFile: async (filePath: string) => {
				fs.writeFileSync(filePath, "export const formatted = true;\n");
				return { success: true, changed: true };
			},
		}));
		vi.doMock("../../clients/lsp/index.js", () => ({
			getLSPService: () =>
				makeLspServiceDouble({
					touchFile: async () => [],
					supportsLSP: () => false,
					getStatus: () => [],
					getAliveServerIds: () => [],
				}),
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
					output: "formatter pipeline output",
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
		const pi = createPiMock({ "immediate-format": true, "no-lsp": true });
		registerExtension(pi.asExtensionAPI());
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-format-live-"));
		const filePath = path.join(cwd, "live.ts");
		fs.writeFileSync(filePath, "export const formatted = false;\n");
		try {
			await pi.emit("session_start", {}, makeCtx({ cwd }));
			await pi.emit("turn_start", {}, makeCtx({ cwd }));
			await pi.emit(
				"tool_result",
				{
					toolName: "edit",
					input: { path: filePath },
					details: { diff: "+ 1 export const formatted = false;" },
					content: [{ type: "text", text: "ok" }],
				},
				makeCtx({ cwd }),
			);
			expect(fs.readFileSync(filePath, "utf8")).toContain("formatted = true");
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	}, 30_000);
});
