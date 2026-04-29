import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CacheManager } from "../../clients/cache-manager.js";
import { consumeTurnEndFindings } from "../../clients/runtime-context.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import { handleSessionStart } from "../../clients/runtime-session.js";
import { handleToolResult } from "../../clients/runtime-tool-result.js";
import { handleTurnEnd } from "../../clients/runtime-turn.js";
import { setupTestEnvironment } from "./test-utils.js";

vi.mock("../../clients/pipeline.js", () => ({
	runPipeline: vi.fn(async () => ({
		output: "no blockers",
		hasBlockers: false,
		isError: false,
		fileModified: false,
		cascadeOutput: "cascade from edited file",
		impactCascadeOutput: "impact cascade from edited file",
	})),
	gatherCascadeDiagnostics: vi.fn(async () => "cascade from turn_end"),
}));

describe("runtime event flow", () => {
	it("flows session_start -> tool_result -> turn_end -> context", async () => {
		const env = setupTestEnvironment("pi-lens-event-flow-");
		const runtime = new RuntimeCoordinator();
		const cacheManager = new CacheManager(false);
		const notify = vi.fn();

		try {
			const filePath = path.join(env.tmpDir, "src", "flow.ts");
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			fs.writeFileSync(filePath, "export const value = 1;\n");

			await handleSessionStart({
				ctxCwd: env.tmpDir,
				getFlag: () => false,
				notify,
				dbg: () => {},
				log: () => {},
				runtime,
				metricsClient: { reset: () => {} },
				cacheManager,
				todoScanner: { scanDirectory: () => ({ items: [] }) },
				astGrepClient: {
					isAvailable: () => false,
					ensureAvailable: async () => false,
					scanExports: async () => new Map(),
				},
				biomeClient: {
					isAvailable: () => false,
					ensureAvailable: async () => false,
				},
				ruffClient: {
					isAvailable: () => false,
					ensureAvailable: async () => false,
				},
				knipClient: {
					isAvailable: () => false,
					ensureAvailable: async () => false,
				},
				jscpdClient: {
					isAvailable: () => false,
					ensureAvailable: async () => false,
				},
				typeCoverageClient: { isAvailable: () => false },
				depChecker: {
					isAvailable: () => false,
					ensureAvailable: async () => false,
				},
				testRunnerClient: { detectRunner: () => null, runTestFile: () => ({}) },
				goClient: { isGoAvailable: () => false },
				rustClient: { isAvailable: () => false },
				ensureTool: async () => null,
				cleanStaleTsBuildInfo: () => [],
				resetDispatchBaselines: () => {},
				resetLSPService: () => {},
			} as any);

			await handleToolResult({
				event: {
					toolName: "write",
					input: { path: filePath },
					details: {},
					content: [{ type: "text", text: "base" }],
				},
				getFlag: () => false,
				dbg: () => {},
				runtime,
				cacheManager,
				biomeClient: {},
				ruffClient: {},
				testRunnerClient: {},
				metricsClient: {},
				resetLSPService: () => {},
				agentBehaviorRecord: () => [],
				formatBehaviorWarnings: () => "",
			} as any);

			cacheManager.addModifiedRange(
				filePath,
				{ start: 1, end: 1 },
				false,
				env.tmpDir,
			);

			expect(runtime.lastCascadeOutput).toContain("cascade from edited file");
			expect(runtime.lastImpactCascadeOutput).toContain(
				"impact cascade from edited file",
			);

			await handleTurnEnd({
				ctxCwd: env.tmpDir,
				getFlag: () => false,
				dbg: () => {},
				runtime,
				cacheManager,
				jscpdClient: { ensureAvailable: async () => false },
				knipClient: { ensureAvailable: async () => false },
				depChecker: { ensureAvailable: async () => false },
				testRunnerClient: { getTestRunTarget: () => null },
				resetLSPService: () => {},
				resetFormatService: () => {},
			} as any);

			expect(runtime.lastCascadeOutput).toBe("");
			expect(runtime.lastImpactCascadeOutput).toBe("");

			const firstContext = consumeTurnEndFindings(cacheManager, env.tmpDir);
			expect(firstContext?.messages[0]?.content).toContain(
				"[pi-lens] End-of-turn findings:",
			);
			expect(firstContext?.messages[0]?.content).toContain(
				"cascade from turn_end",
			);
			// impact cascade is consumed but not re-gathered at turn_end

			const secondContext = consumeTurnEndFindings(cacheManager, env.tmpDir);
			expect(secondContext).toBeUndefined();
		} finally {
			env.cleanup();
		}
	});
});
