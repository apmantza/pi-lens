import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	PROJECT_SNAPSHOT_VERSION,
	saveProjectSnapshot,
} from "../../clients/project-snapshot.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import { handleSessionStart } from "../../clients/runtime-session.js";
import { createTempFile, setupTestEnvironment } from "./test-utils.js";

// Stub the LSP service so the no-warmFiles dominant-language auto-warm (#203)
// can't spawn a real language server against the throwaway temp dirs (which the
// afterEach cleanup would then race). supportsLSP:false short-circuits the warm
// before it opens any file.
vi.mock("../../clients/lsp/index.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../clients/lsp/index.js")>()),
	getLSPService: vi.fn(() => ({
		supportsLSP: () => false,
		touchFile: vi.fn(async () => undefined),
	})),
}));

const EMPTY_KNIP_RESULT = {
	success: true,
	issues: [],
	unusedExports: [],
	unusedFiles: [],
	unusedDeps: [],
	unlistedDeps: [],
	summary: "skipped",
};

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
	const scanFile = vi.fn((): unknown[] => []);
	const ensureTool = vi.fn(async () => null);
	const astGrepEnsure = vi.fn(async () => false);
	const biomeEnsure = vi.fn(async () => false);
	const ruffEnsure = vi.fn(async () => false);
	const knipEnsure = vi.fn(async () => false);
	const knipAnalyze = vi.fn(async () => EMPTY_KNIP_RESULT);
	const jscpdEnsure = vi.fn(async () => false);
	const depEnsure = vi.fn(async () => false);
	const resetLSPService = vi.fn();
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
			todoScanner: { scanDirectory, scanFile },
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
				analyze: knipAnalyze,
			},
			jscpdClient: {
				isAvailable: () => false,
				ensureAvailable: jscpdEnsure,
			},
			depChecker: {
				isAvailable: () => false,
				ensureAvailable: depEnsure,
			},
			testRunnerClient: {
				detectRunner: () => ({ runner: "vitest", config: null }),
				runTestFile: () => ({ failed: 1, error: false }),
			},
			goClient: { isGoAvailableAsync: async () => false },
			rustClient: { isAvailableAsync: async () => false },
			ensureTool,
			cleanStaleTsBuildInfo: () => ["tsconfig.tsbuildinfo"],
			resetDispatchBaselines: () => {},
			resetLSPService,
		} as any);

		return {
			env,
			notify,
			scanDirectory,
			scanFile,
			ensureTool,
			astGrepEnsure,
			biomeEnsure,
			ruffEnsure,
			knipEnsure,
			knipAnalyze,
			jscpdEnsure,
			depEnsure,
			resetLSPService,
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
	it("quick mode hydrates cached exports and rules from a fresh project snapshot", async () => {
		const env = setupTestEnvironment("pi-lens-session-snapshot-");
		const restoreStartupMode = setStartupMode("quick");
		const previousDataDir = process.env.PILENS_DATA_DIR;
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		const runtime = new RuntimeCoordinator();
		try {
			saveProjectSnapshot(env.tmpDir, {
				version: PROJECT_SNAPSHOT_VERSION,
				projectRoot: env.tmpDir,
				generatedAt: new Date().toISOString(),
				seq: 0,
				files: {},
				symbols: {},
				reverseDeps: {},
				cachedExports: [["fromSnapshot", path.join(env.tmpDir, "src/a.ts")]],
				projectRulesScan: {
					hasCustomRules: true,
					rules: [
						{
							source: "root",
							name: "AGENTS.md",
							filePath: path.join(env.tmpDir, "AGENTS.md"),
							relativePath: "AGENTS.md",
						},
					],
				},
			});

			await handleSessionStart({
				ctxCwd: env.tmpDir,
				getFlag: (name: string) => name === "no-lsp",
				notify: () => {},
				dbg: () => {},
				log: () => {},
				runtime,
				metricsClient: { reset: () => {} },
				cacheManager: { writeCache: () => {}, readCache: () => null },
				todoScanner: { scanDirectory: () => ({ items: [] }) },
				astGrepClient: {},
				biomeClient: {},
				ruffClient: {},
				knipClient: {},
				jscpdClient: {},
				depChecker: {},
				testRunnerClient: {},
				goClient: {},
				rustClient: {},
				ensureTool: async () => null,
				cleanStaleTsBuildInfo: () => [],
				resetDispatchBaselines: () => {},
				resetLSPService: () => {},
			} as any);

			expect(runtime.cachedExports.get("fromSnapshot")).toBe(
				path.join(env.tmpDir, "src/a.ts"),
			);
			expect(runtime.projectRulesScan.hasCustomRules).toBe(true);
			expect(runtime.projectRulesScan.rules[0]?.name).toBe("AGENTS.md");
		} finally {
			restoreStartupMode();
			if (previousDataDir === undefined) {
				delete process.env.PILENS_DATA_DIR;
			} else {
				process.env.PILENS_DATA_DIR = previousDataDir;
			}
			env.cleanup();
		}
	});

	it("quick mode hydrates project-root snapshot when started from a nested cwd", async () => {
		const env = setupTestEnvironment("pi-lens-session-nested-snapshot-");
		const restoreStartupMode = setStartupMode("quick");
		const previousDataDir = process.env.PILENS_DATA_DIR;
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		const runtime = new RuntimeCoordinator();
		const nestedFile = createTempFile(
			env.tmpDir,
			"packages/app/src/index.ts",
			"export const value = 1;\n",
		);
		const nestedCwd = path.dirname(nestedFile);
		createTempFile(
			env.tmpDir,
			"package.json",
			JSON.stringify({ type: "module" }),
		);
		try {
			saveProjectSnapshot(env.tmpDir, {
				version: PROJECT_SNAPSHOT_VERSION,
				projectRoot: env.tmpDir,
				generatedAt: new Date().toISOString(),
				seq: 0,
				files: {},
				symbols: {},
				reverseDeps: {},
				cachedExports: [["nestedSnapshot", nestedFile]],
				projectRulesScan: { hasCustomRules: true, rules: [] },
			});

			await handleSessionStart({
				ctxCwd: nestedCwd,
				getFlag: (name: string) => name === "no-lsp",
				notify: () => {},
				dbg: () => {},
				log: () => {},
				runtime,
				metricsClient: { reset: () => {} },
				cacheManager: { writeCache: () => {}, readCache: () => null },
				todoScanner: { scanDirectory: () => ({ items: [] }) },
				astGrepClient: {},
				biomeClient: {},
				ruffClient: {},
				knipClient: {},
				jscpdClient: {},
				depChecker: {},
				testRunnerClient: {},
				goClient: {},
				rustClient: {},
				ensureTool: async () => null,
				cleanStaleTsBuildInfo: () => [],
				resetDispatchBaselines: () => {},
				resetLSPService: () => {},
			} as any);

			expect(runtime.cachedExports.get("nestedSnapshot")).toBe(nestedFile);
			expect(runtime.projectRulesScan.hasCustomRules).toBe(true);
		} finally {
			restoreStartupMode();
			if (previousDataDir === undefined) {
				delete process.env.PILENS_DATA_DIR;
			} else {
				process.env.PILENS_DATA_DIR = previousDataDir;
			}
			env.cleanup();
		}
	});

	it("full mode emits build-cache warning while avoiding startup info noise", async () => {
		const { env, notify, scanDirectory, ensureTool, resetLSPService } =
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
			expect(resetLSPService).toHaveBeenCalledWith({ fast: true });
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

	it("defers startup scan task bodies until after session_start returns", async () => {
		const { env, scanFile } = await runSessionStart("full", (tmpDir) => {
			createTempFile(
				tmpDir,
				"package.json",
				JSON.stringify({ type: "module" }),
			);
			createTempFile(tmpDir, "src/index.ts", "export const value = 1;\n");
		});

		try {
			// The todo scan now runs per-file via scanFile (chunked/yielded) rather
			// than a single blocking scanDirectory. It must be deferred until after
			// session_start returns, then run.
			expect(scanFile).not.toHaveBeenCalled();
			await vi.waitFor(() => expect(scanFile).toHaveBeenCalled());
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
			knipAnalyze,
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
			await vi.waitFor(() => expect(astGrepEnsure).toHaveBeenCalledTimes(1));

			// biome is covered by startup preinstall; ast-grep/knip/jscpd by startup
			// scans. ruff is irrelevant for this JS/TS-only project.
			expect(biomeEnsure).not.toHaveBeenCalled();
			expect(ruffEnsure).not.toHaveBeenCalled();
			expect(knipEnsure).not.toHaveBeenCalled();
			expect(knipAnalyze).toHaveBeenCalledTimes(1);
			expect(jscpdEnsure).toHaveBeenCalledTimes(1);
		} finally {
			env.cleanup();
		}
	});
});
