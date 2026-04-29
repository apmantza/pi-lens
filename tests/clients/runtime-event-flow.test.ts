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
		cascadeResult: undefined,
	})),
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

			// cascadeResult is undefined (mock returns undefined) — no accumulation
			expect(runtime.consumeCascadeResults()).toHaveLength(0);

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

			// No cascade results, no jscpd/knip blockers — turn_end clears state
			const firstContext = consumeTurnEndFindings(cacheManager, env.tmpDir);
			expect(firstContext).toBeUndefined();
		} finally {
			env.cleanup();
		}
	});
});
