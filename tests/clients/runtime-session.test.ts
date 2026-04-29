import { afterEach, describe, expect, it, vi } from "vitest";
import { handleSessionStart } from "../../clients/runtime-session.js";
import { setupTestEnvironment } from "./test-utils.js";

function setStartupMode(mode: "full" | "quick"): () => void {
	const prev = process.env.PI_LENS_STARTUP_MODE;
	process.env.PI_LENS_STARTUP_MODE = mode;
	return () => {
		if (prev === undefined) delete process.env.PI_LENS_STARTUP_MODE;
		else process.env.PI_LENS_STARTUP_MODE = prev;
	};
}

async function runSessionStart(mode: "full" | "quick") {
	const env = setupTestEnvironment("pi-lens-runtime-session-");
	const notify = vi.fn();
	const scanDirectory = vi.fn(() => ({ items: [] }));
	const ensureTool = vi.fn(async () => null);
	const restoreStartupMode = setStartupMode(mode);

	try {
		await handleSessionStart({
			ctxCwd: env.tmpDir,
			getFlag: (name: string) => {
				if (name === "lens-lsp") return true;
				if (name === "no-lsp") return false;
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
			todoScanner: { scanDirectory },
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
			testRunnerClient: {
				detectRunner: () => ({ runner: "vitest", config: null }),
				runTestFile: () => ({ failed: 1, error: false }),
			},
			goClient: { isGoAvailable: () => false },
			rustClient: { isAvailable: () => false },
			ensureTool,
			cleanStaleTsBuildInfo: () => ["tsconfig.tsbuildinfo"],
			resetDispatchBaselines: () => {},
			resetLSPService: () => {},
		} as any);

		return { env, notify, scanDirectory, ensureTool };
	} catch (error) {
		env.cleanup();
		throw error;
	} finally {
		restoreStartupMode();
	}
}

afterEach(() => {
	delete process.env.PI_LENS_STARTUP_MODE;
});

describe("runtime-session notifications", () => {
	it("full mode emits build-cache warning while avoiding startup info noise", async () => {
		const { env, notify, scanDirectory, ensureTool } =
			await runSessionStart("full");

		try {
			const infoCalls = notify.mock.calls.filter(
				([, level]) => level === "info",
			);
			const warningCalls = notify.mock.calls.filter(
				([, level]) => level === "warning",
			);

			expect(infoCalls).toHaveLength(0);
			// TypeScript build cache warning still expected
			expect(
				warningCalls.some(([msg]) => msg.includes("TypeScript build cache")),
			).toBe(true);
			// ERROR DEBT feature removed - no longer expected
			expect(warningCalls.some(([msg]) => msg.includes("ERROR DEBT"))).toBe(
				false,
			);
			expect(scanDirectory).not.toHaveBeenCalled();
			expect(ensureTool).not.toHaveBeenCalled();
		} finally {
			env.cleanup();
		}
	});

	it("quick mode skips build-cache cleanup and error-debt checks", async () => {
		const { env, notify, scanDirectory, ensureTool } =
			await runSessionStart("quick");

		try {
			const infoCalls = notify.mock.calls.filter(
				([, level]) => level === "info",
			);
			const warningCalls = notify.mock.calls.filter(
				([, level]) => level === "warning",
			);

			expect(infoCalls).toHaveLength(0);
			expect(
				warningCalls.some(([msg]) => msg.includes("TypeScript build cache")),
			).toBe(false);
			expect(warningCalls.some(([msg]) => msg.includes("ERROR DEBT"))).toBe(
				false,
			);
			expect(scanDirectory).not.toHaveBeenCalled();
			expect(ensureTool).not.toHaveBeenCalled();
		} finally {
			env.cleanup();
		}
	});
});
