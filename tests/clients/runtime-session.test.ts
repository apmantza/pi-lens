import { afterEach, describe, expect, it, vi } from "vitest";
import { handleSessionStart } from "../../clients/runtime-session.js";
import { createTempFile, setupTestEnvironment } from "./test-utils.js";

function setStartupMode(mode: "full" | "quick"): () => void {
	const prev = process.env.PI_LENS_STARTUP_MODE;
	process.env.PI_LENS_STARTUP_MODE = mode;
	return () => {
		if (prev === undefined) delete process.env.PI_LENS_STARTUP_MODE;
		else process.env.PI_LENS_STARTUP_MODE = prev;
	};
}

async function runSessionStart(
	mode: "full" | "quick",
	setup?: (tmpDir: string) => void,
) {
	const env = setupTestEnvironment("pi-lens-runtime-session-");
	setup?.(env.tmpDir);
	const notify = vi.fn();
	const scanDirectory = vi.fn(() => ({ items: [] }));
	const ensureTool = vi.fn(async () => null);
	const astGrepEnsure = vi.fn(async () => false);
	const biomeEnsure = vi.fn(async () => false);
	const ruffEnsure = vi.fn(async () => false);
	const knipEnsure = vi.fn(async () => false);
	const jscpdEnsure = vi.fn(async () => false);
	const depEnsure = vi.fn(async () => false);
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
				ensureAvailable: astGrepEnsure,
				scanExports: async () => new Map(),
			},
			biomeClient: {
				isAvailable: () => false,
				ensureAvailable: biomeEnsure,
			},
			ruffClient: {
				isAvailable: () => false,
				ensureAvailable: ruffEnsure,
			},
			knipClient: {
				isAvailable: () => false,
				ensureAvailable: knipEnsure,
			},
			jscpdClient: {
				isAvailable: () => false,
				ensureAvailable: jscpdEnsure,
			},
			typeCoverageClient: { isAvailable: () => false },
			depChecker: {
				isAvailable: () => false,
				ensureAvailable: depEnsure,
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

		return {
			env,
			notify,
			scanDirectory,
			ensureTool,
			astGrepEnsure,
			biomeEnsure,
			ruffEnsure,
			knipEnsure,
			jscpdEnsure,
			depEnsure,
		};
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

	it("limits deferred availability probes to relevant uncovered tools", async () => {
		const {
			env,
			biomeEnsure,
			ruffEnsure,
			depEnsure,
			astGrepEnsure,
			knipEnsure,
			jscpdEnsure,
		} = await runSessionStart("full", (tmpDir) => {
			createTempFile(
				tmpDir,
				"package.json",
				JSON.stringify({ type: "module" }),
			);
			createTempFile(tmpDir, "src/index.ts", "export const value = 1;\n");
		});

		try {
			await vi.waitFor(() => expect(depEnsure).toHaveBeenCalledTimes(1));

			// biome is covered by startup preinstall; ast-grep/knip/jscpd by startup
			// scans. ruff is irrelevant for this JS/TS-only project.
			expect(biomeEnsure).not.toHaveBeenCalled();
			expect(ruffEnsure).not.toHaveBeenCalled();
			expect(astGrepEnsure).toHaveBeenCalledTimes(1);
			expect(knipEnsure).toHaveBeenCalledTimes(1);
			expect(jscpdEnsure).toHaveBeenCalledTimes(1);
		} finally {
			env.cleanup();
		}
	});
});
