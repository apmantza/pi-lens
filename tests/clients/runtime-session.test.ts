import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	PROJECT_SNAPSHOT_VERSION,
	saveProjectSnapshot,
} from "../../clients/project-snapshot.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import { handleSessionStart } from "../../clients/runtime-session.js";
import { _resetSlowFsForTests } from "../../clients/slow-fs.js";
import { _resetSubagentModeForTests } from "../../clients/subagent-mode.js";
import { createTempFile, setupTestEnvironment } from "./test-utils.js";

// Stub the LSP service so the no-warmFiles dominant-language auto-warm (#203)
// can't spawn a real language server against the throwaway temp dirs (which the
// afterEach cleanup would then race). supportsLSP:false short-circuits the warm
// before it opens any file.
const mockTouchFile = vi.fn(async () => undefined);
vi.mock("../../clients/lsp/index.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../clients/lsp/index.js")>()),
	getLSPService: vi.fn(() => ({
		supportsLSP: () => false,
		touchFile: mockTouchFile,
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
	const dbg = vi.fn();
	const restoreStartupMode = setStartupMode(mode);
	mockTouchFile.mockClear();

	try {
		await handleSessionStart({
			ctxCwd: env.tmpDir,
			getFlag: (name: string) => {
				if (name === "lens-lsp") return true;
				if (name === "no-lsp") return false;
				return false;
			},
			notify,
			dbg,
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
			dbg,
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
			expect(resetLSPService).toHaveBeenCalledWith({ fast: true, reason: "session_start" });
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

	it("slow-FS mode skips heavyweight CLI scans but keeps the later in-process scans (#462)", async () => {
		process.env.PI_LENS_FORCE_SLOW_FS = "1";
		_resetSlowFsForTests();
		try {
			const { env, notify, scanFile, astGrepEnsure, knipAnalyze, jscpdEnsure } =
				await runSessionStart("full", (tmpDir) => {
					createTempFile(
						tmpDir,
						"package.json",
						JSON.stringify({ type: "module" }),
					);
					createTempFile(tmpDir, "src/index.ts", "export const value = 1;\n");
				});

			try {
				// ast-grep-exports is scheduled AFTER the seven skipped scans in
				// scheduleStartupScans — it must still run in slow-FS mode (the
				// original guard was an early `return` that wrongly killed it and
				// call-graph/codebase-model/word-index along with knip/jscpd/etc).
				await vi.waitFor(() => expect(astGrepEnsure).toHaveBeenCalledTimes(1));
				// todo (before the guard) also stays on.
				await vi.waitFor(() => expect(scanFile).toHaveBeenCalled());

				// The external-CLI scans are skipped…
				expect(knipAnalyze).not.toHaveBeenCalled();
				expect(jscpdEnsure).not.toHaveBeenCalled();
				// …with a visible degradation notice, never silently.
				expect(
					notify.mock.calls.some(([msg]) =>
						String(msg).includes("PI_LENS_ALLOW_SLOW_FS_SCAN=1"),
					),
				).toBe(true);
			} finally {
				env.cleanup();
			}
		} finally {
			delete process.env.PI_LENS_FORCE_SLOW_FS;
			_resetSlowFsForTests();
		}
	});

	it("subagent light mode skips heavyweight CLI scans but keeps the later in-process scans (#449)", async () => {
		process.env.PI_SUBAGENT_CHILD = "1";
		_resetSubagentModeForTests();
		try {
			const {
				env,
				notify,
				scanFile,
				astGrepEnsure,
				knipAnalyze,
				jscpdEnsure,
				dbg,
			} = await runSessionStart("full", (tmpDir) => {
				createTempFile(
					tmpDir,
					"package.json",
					JSON.stringify({ type: "module" }),
				);
				createTempFile(tmpDir, "src/index.ts", "export const value = 1;\n");
			});

			try {
				// In-process scans (ast-grep-exports, todo) stay on — same contract
				// as the slow-FS gate above.
				await vi.waitFor(() => expect(astGrepEnsure).toHaveBeenCalledTimes(1));
				await vi.waitFor(() => expect(scanFile).toHaveBeenCalled());

				// The external-CLI scans are skipped…
				expect(knipAnalyze).not.toHaveBeenCalled();
				expect(jscpdEnsure).not.toHaveBeenCalled();
				// …with a visible degradation notice, never silently.
				expect(
					notify.mock.calls.some(([msg]) =>
						String(msg).includes("PI_LENS_SUBAGENT_FULL=1"),
					),
				).toBe(true);
				// The LSP pre-warm is also skipped in light mode — the dbg log line
				// is the only cheaply observable signal here (the LSP service mock's
				// supportsLSP:false already makes touchFile call-count useless as a
				// discriminator between "skipped" and "ran but found no LSP-backed
				// file to warm").
				expect(
					dbg.mock.calls.some(([msg]) =>
						String(msg).includes("skipping pre-warm (subagent session)"),
					),
				).toBe(true);
				expect(mockTouchFile).not.toHaveBeenCalled();
			} finally {
				env.cleanup();
			}
		} finally {
			delete process.env.PI_SUBAGENT_CHILD;
			_resetSubagentModeForTests();
		}
	});

	it("PI_LENS_SUBAGENT_FULL=1 restores full behavior inside a subagent session (#449)", async () => {
		process.env.PI_SUBAGENT_CHILD = "1";
		process.env.PI_LENS_SUBAGENT_FULL = "1";
		_resetSubagentModeForTests();
		try {
			const { env, notify, knipAnalyze, jscpdEnsure } = await runSessionStart(
				"full",
				(tmpDir) => {
					createTempFile(
						tmpDir,
						"package.json",
						JSON.stringify({ type: "module" }),
					);
					createTempFile(tmpDir, "src/index.ts", "export const value = 1;\n");
				},
			);

			try {
				await vi.waitFor(() => expect(knipAnalyze).toHaveBeenCalledTimes(1));
				expect(jscpdEnsure).toHaveBeenCalledTimes(1);
				expect(
					notify.mock.calls.some(([msg]) =>
						String(msg).includes("PI_LENS_SUBAGENT_FULL=1"),
					),
				).toBe(false);
			} finally {
				env.cleanup();
			}
		} finally {
			delete process.env.PI_SUBAGENT_CHILD;
			delete process.env.PI_LENS_SUBAGENT_FULL;
			_resetSubagentModeForTests();
		}
	});

	it("startupModeOverride:'full' on first call gets full mode (MCP host path, #546)", async () => {
		// Simulate the MCP host: first call of the process, no PI_LENS_STARTUP_MODE
		// set in env, but deps.startupModeOverride = "full". The dbg log line
		// "startup mode: full" is the cheapest reliable discriminant — it's
		// emitted synchronously for every startup mode before the quick/full
		// branch diverges.
		const env = setupTestEnvironment("pi-lens-mcp-startup-mode-");
		const globals = globalThis as unknown as {
			__piLensFirstSessionDone?: boolean;
			__piLensWarmupScheduled?: boolean;
		};
		const prevFirst = globals.__piLensFirstSessionDone;
		const prevWarmup = globals.__piLensWarmupScheduled;
		globals.__piLensFirstSessionDone = false;
		globals.__piLensWarmupScheduled = false;
		delete process.env.PI_LENS_STARTUP_MODE;
		const dbg = vi.fn();
		try {
			await handleSessionStart({
				ctxCwd: env.tmpDir,
				startupModeOverride: "full",
				getFlag: (name: string) => name === "no-lsp",
				notify: () => {},
				dbg,
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
				cacheManager: { writeCache: () => {}, readCache: () => null },
				todoScanner: { scanDirectory: () => ({ items: [] }), scanFile: () => [] },
				astGrepClient: { isAvailable: () => false, ensureAvailable: async () => false, scanExports: async () => new Map() },
				biomeClient: { isAvailable: () => false, ensureAvailable: async () => false },
				ruffClient: { isAvailable: () => false, ensureAvailable: async () => false },
				knipClient: { isAvailable: () => false, ensureAvailable: async () => false, analyze: async () => ({ success: true, issues: [], unusedExports: [], unusedFiles: [], unusedDeps: [], unlistedDeps: [], summary: "skipped" }) },
				jscpdClient: { isAvailable: () => false, ensureAvailable: async () => false },
				depChecker: { isAvailable: () => false, ensureAvailable: async () => false },
				testRunnerClient: { detectRunner: () => ({ runner: "vitest", config: null }), runTestFile: () => ({ failed: 1, error: false }) },
				goClient: { isGoAvailableAsync: async () => false },
				rustClient: { isAvailableAsync: async () => false },
				ensureTool: async () => null,
				cleanStaleTsBuildInfo: () => [],
				resetDispatchBaselines: () => {},
				resetLSPService: () => {},
			} as any);
			// dbg records the resolved startup mode synchronously
			expect(
				dbg.mock.calls.some(([msg]) =>
					String(msg).includes("startup mode: full"),
				),
			).toBe(true);
			// quick-mode emits a "skipping slow tool probes" dbg line; full does not
			expect(
				dbg.mock.calls.some(([msg]) =>
					String(msg).includes("quick mode active"),
				),
			).toBe(false);
		} finally {
			globals.__piLensFirstSessionDone = prevFirst;
			globals.__piLensWarmupScheduled = prevWarmup;
			env.cleanup();
		}
	});

	it("plain/TUI first call (no startupModeOverride) still gets quick mode (#546 non-regression)", async () => {
		// Ensure the TUI path is unchanged: first call with no override → quick.
		const env = setupTestEnvironment("pi-lens-tui-startup-mode-");
		const globals = globalThis as unknown as {
			__piLensFirstSessionDone?: boolean;
			__piLensWarmupScheduled?: boolean;
		};
		const prevFirst = globals.__piLensFirstSessionDone;
		const prevWarmup = globals.__piLensWarmupScheduled;
		globals.__piLensFirstSessionDone = false;
		globals.__piLensWarmupScheduled = false;
		delete process.env.PI_LENS_STARTUP_MODE;
		const dbg = vi.fn();
		try {
			await handleSessionStart({
				ctxCwd: env.tmpDir,
				// no startupModeOverride → TUI heuristic applies → quick
				getFlag: (name: string) => name === "no-lsp",
				notify: () => {},
				dbg,
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
				cacheManager: { writeCache: () => {}, readCache: () => null },
				todoScanner: { scanDirectory: () => ({ items: [] }), scanFile: () => [] },
				astGrepClient: { isAvailable: () => false, ensureAvailable: async () => false, scanExports: async () => new Map() },
				biomeClient: { isAvailable: () => false, ensureAvailable: async () => false },
				ruffClient: { isAvailable: () => false, ensureAvailable: async () => false },
				knipClient: { isAvailable: () => false, ensureAvailable: async () => false, analyze: async () => ({ success: true, issues: [], unusedExports: [], unusedFiles: [], unusedDeps: [], unlistedDeps: [], summary: "skipped" }) },
				jscpdClient: { isAvailable: () => false, ensureAvailable: async () => false },
				depChecker: { isAvailable: () => false, ensureAvailable: async () => false },
				testRunnerClient: { detectRunner: () => ({ runner: "vitest", config: null }), runTestFile: () => ({ failed: 1, error: false }) },
				goClient: { isGoAvailableAsync: async () => false },
				rustClient: { isAvailableAsync: async () => false },
				ensureTool: async () => null,
				cleanStaleTsBuildInfo: () => [],
				resetDispatchBaselines: () => {},
				resetLSPService: () => {},
			} as any);
			expect(
				dbg.mock.calls.some(([msg]) =>
					String(msg).includes("startup mode: quick"),
				),
			).toBe(true);
			expect(
				dbg.mock.calls.some(([msg]) =>
					String(msg).includes("quick mode active"),
				),
			).toBe(true);
		} finally {
			globals.__piLensFirstSessionDone = prevFirst;
			globals.__piLensWarmupScheduled = prevWarmup;
			env.cleanup();
		}
	});

	it("explicit PI_LENS_STARTUP_MODE env wins over startupModeOverride (both hosts, #546)", async () => {
		// Even with startupModeOverride:"full", if PI_LENS_STARTUP_MODE=quick is
		// set, the env var takes precedence (highest priority rule).
		const env = setupTestEnvironment("pi-lens-env-override-startup-mode-");
		const globals = globalThis as unknown as {
			__piLensFirstSessionDone?: boolean;
			__piLensWarmupScheduled?: boolean;
		};
		const prevFirst = globals.__piLensFirstSessionDone;
		const prevWarmup = globals.__piLensWarmupScheduled;
		globals.__piLensFirstSessionDone = false;
		globals.__piLensWarmupScheduled = false;
		process.env.PI_LENS_STARTUP_MODE = "quick";
		const dbg = vi.fn();
		try {
			await handleSessionStart({
				ctxCwd: env.tmpDir,
				startupModeOverride: "full", // would normally force full for MCP host…
				getFlag: (name: string) => name === "no-lsp",
				notify: () => {},
				dbg,
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
				cacheManager: { writeCache: () => {}, readCache: () => null },
				todoScanner: { scanDirectory: () => ({ items: [] }), scanFile: () => [] },
				astGrepClient: { isAvailable: () => false, ensureAvailable: async () => false, scanExports: async () => new Map() },
				biomeClient: { isAvailable: () => false, ensureAvailable: async () => false },
				ruffClient: { isAvailable: () => false, ensureAvailable: async () => false },
				knipClient: { isAvailable: () => false, ensureAvailable: async () => false, analyze: async () => ({ success: true, issues: [], unusedExports: [], unusedFiles: [], unusedDeps: [], unlistedDeps: [], summary: "skipped" }) },
				jscpdClient: { isAvailable: () => false, ensureAvailable: async () => false },
				depChecker: { isAvailable: () => false, ensureAvailable: async () => false },
				testRunnerClient: { detectRunner: () => ({ runner: "vitest", config: null }), runTestFile: () => ({ failed: 1, error: false }) },
				goClient: { isGoAvailableAsync: async () => false },
				rustClient: { isAvailableAsync: async () => false },
				ensureTool: async () => null,
				cleanStaleTsBuildInfo: () => [],
				resetDispatchBaselines: () => {},
				resetLSPService: () => {},
			} as any);
			// PI_LENS_STARTUP_MODE=quick wins → resolveStartupMode() returns "quick"
			// before the heuristic even runs (env var check skips the override branch)
			expect(
				dbg.mock.calls.some(([msg]) =>
					String(msg).includes("startup mode: quick"),
				),
			).toBe(true);
		} finally {
			globals.__piLensFirstSessionDone = prevFirst;
			globals.__piLensWarmupScheduled = prevWarmup;
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
