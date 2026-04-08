import { describe, expect, it, vi } from "vitest";
import { handleSessionStart } from "../../clients/runtime-session.js";
import { setupTestEnvironment } from "./test-utils.js";

describe("runtime-session notifications", () => {
	it("emits one compact startup info note and keeps critical warnings separate", async () => {
		const env = setupTestEnvironment("pi-lens-runtime-session-");
		const notify = vi.fn();

		try {
			await handleSessionStart({
				ctxCwd: env.tmpDir,
				getFlag: (name: string) => {
					if (name === "lens-lsp") return true;
					if (name === "no-lsp") return false;
					if (name === "error-debt") return true;
					return false;
				},
				notify,
				dbg: () => {},
				log: () => {},
				runtime: {
					sessionGeneration: 1,
					isCurrentSession: () => true,
					markStartupScanInFlight: () => {},
					clearStartupScanInFlight: () => {},
					complexityBaselines: new Map(),
					resetForSession: () => {},
					projectRoot: "",
					projectRulesScan: { hasCustomRules: false, rules: [] },
					cachedExports: new Map(),
					cachedProjectIndex: null,
					errorDebtBaseline: { testsPassed: true, buildPassed: true },
				},
				metricsClient: { reset: () => {} },
				cacheManager: {
					writeCache: () => {},
					readCache: (key: string) => {
						if (key === "errorDebt") {
							return {
								data: { pendingCheck: true, baselineTestsPassed: true },
							};
						}
						return null;
					},
				},
				todoScanner: { scanDirectory: () => ({ items: [] }) },
				astGrepClient: {
					isAvailable: () => false,
					ensureAvailable: async () => false,
					scanExports: async () => new Map(),
				},
				biomeClient: { isAvailable: () => false },
				ruffClient: { isAvailable: () => false },
				knipClient: { isAvailable: () => false, ensureAvailable: async () => false },
				jscpdClient: { isAvailable: () => false, ensureAvailable: async () => false },
				typeCoverageClient: { isAvailable: () => false },
				depChecker: { isAvailable: () => false },
				architectClient: { loadConfig: () => false },
				testRunnerClient: {
					detectRunner: () => ({ runner: "vitest", config: null }),
					runTestFile: () => ({ failed: 1, error: false }),
				},
				goClient: { isGoAvailable: () => false },
				rustClient: { isAvailable: () => false },
				ensureTool: async () => null,
				cleanStaleTsBuildInfo: () => ["tsconfig.tsbuildinfo"],
				resetDispatchBaselines: () => {},
				resetLSPService: () => {},
			} as any);

			const infoCalls = notify.mock.calls.filter(([, level]) => level === "info");
			const warningCalls = notify.mock.calls.filter(
				([, level]) => level === "warning",
			);

			expect(infoCalls).toHaveLength(1);
			expect(infoCalls[0][0]).toContain("pi-lens active");
			expect(infoCalls[0][0]).toContain("lsp_navigation");

			expect(warningCalls.some(([msg]) => msg.includes("TypeScript build cache"))).toBe(
				true,
			);
			expect(warningCalls.some(([msg]) => msg.includes("ERROR DEBT"))).toBe(true);
		} finally {
			env.cleanup();
		}
	});
});
