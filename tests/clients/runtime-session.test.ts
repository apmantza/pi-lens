import fs from "node:fs";
import { withResidentBootstrap } from "../support/bootstrap-access.js";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getGlobalPiLensDir } from "../../clients/file-utils.js";
import {
	PROJECT_SNAPSHOT_VERSION,
	saveProjectSnapshot,
} from "../../clients/project-snapshot.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import {
	loadPiLensGlobalConfig,
	resolvePiLensFlag,
	type PiLensGlobalConfig,
} from "../../clients/lens-config.js";
import {
	loadPiLensProjectConfig,
	type PiLensProjectConfig,
} from "../../clients/project-lens-config.js";
import { handleSessionStart } from "../../clients/runtime-session.js";
import { _resetSlowFsForTests } from "../../clients/slow-fs.js";
import { _resetSubagentModeForTests } from "../../clients/subagent-mode.js";
import { createTempFile, setupTestEnvironment } from "./test-utils.js";
import { waitFor as waitForCondition } from "./interleaving-kit.js";
import { makeLspServiceDouble } from "../support/lsp-service-double.js";

/** A pid guaranteed dead on this machine, for orphan-staging-file tests
 *  (mirrors tests/clients/atomic-write-stage-gc.test.ts's helper). */
function findDeadPid(): number {
	for (let candidate = 999_983; candidate > 1_000; candidate -= 7_919) {
		try {
			process.kill(candidate, 0);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ESRCH") return candidate;
		}
	}
	throw new Error("could not find a definitively dead pid");
}

// Stub the LSP service so the no-warmFiles dominant-language auto-warm (#203)
// can't spawn a real language server against the throwaway temp dirs (which the
// afterEach cleanup would then race). supportsLSP:false short-circuits the warm
// before it opens any file.
const mockTouchFile = vi.fn(async () => undefined);
vi.mock("../../clients/lsp/index.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../clients/lsp/index.js")>()),
	getLSPService: vi.fn(() =>
		makeLspServiceDouble({
			supportsLSP: () => false,
			touchFile: mockTouchFile,
		}),
	),
}));

// #1767: every test in this file drives `handleSessionStart`, which does
// real synchronous fs work (detectProjectLanguageProfile, scanProjectRules)
// plus fire-and-forget background scans (`scheduleStartupScans`) that reach
// their `todoScanner.scanFile`/tool-`ensureAvailable` mocks only after a real
// `setImmediate` tick and, for `collectTodoBaselineItems`, real per-file fs
// reads against a temp project dir. Solo runs of this file measured 8-13s for
// all 14 tests combined (well inside both `vi.waitFor`'s 1000ms default and
// vitest's 5000ms `testTimeout` default). Under contention — this file run 6x
// in parallel, `PI_LENS_TEST_MAX_WORKERS=1` each, N=24 samples — 8 runs
// (33%) failed: some on individual `vi.waitFor` calls timing out waiting for
// a scan mock to fire, others on the whole test (no `vi.waitFor` in the body)
// blowing the 5000ms default `testTimeout` while `handleSessionStart` itself
// ran long. This reproduces the reporter's ~1-in-8 rate and matches their A/B
// evidence that swapping only `clients/runtime-session.ts` between branches
// didn't change the failure rate — the production code is not the cause. The
// budget below matches this repo's `HEAVY_IO_TIMEOUT_MS` convention
// (tests/clients/ast-grep-rule-precedence-followups.test.ts) and gives ~4x
// headroom over the worst contended full-test duration observed.
//
// The enclosing `describe`/`it` budget is deliberately larger than the
// `vi.waitFor` budget it wraps (45_000 vs 30_000, not the same number). If
// they matched, a genuine failure would race the two timeouts and could let
// the outer, generic "Test timed out in Nms" win instead of the inner
// `vi.waitFor` — discarding the specific, debuggable message ("orphan
// staging files not yet reaped", "background startup scans still touching
// tmpDir", or the mock assertion diff) that a real regression needs. The 15s
// gap is enough for `vi.waitFor`'s own rejection, plus the `finally` block's
// `env.cleanup()`, to run and surface before the outer clock fires. This is
// inherent to the fire-and-forget-scan precedent this file follows (no
// deterministic completion signal exists to swap in instead — see the
// file-level comment above) and does not itself detect a genuine slowdown in
// `handleSessionStart`; at 30x the worst observed solo per-test time, a real
// regression there would still pass unnoticed until it also blew the 45s
// ceiling.
const HEAVY_IO_TIMEOUT_MS = 30_000;
const TEST_BUDGET_MS = 45_000;

const EMPTY_KNIP_RESULT = {
	success: true,
	issues: [],
	unusedExports: [],
	unusedFiles: [],
	unusedDeps: [],
	unlistedDeps: [],
	summary: "skipped",
};

function setStartupMode(mode: "full" | "quick" | "minimal"): () => void {
	const prev = process.env.PI_LENS_STARTUP_MODE;
	process.env.PI_LENS_STARTUP_MODE = mode;
	return () => {
		if (prev === undefined) delete process.env.PI_LENS_STARTUP_MODE;
		else process.env.PI_LENS_STARTUP_MODE = prev;
	};
}

function writeConfig(filePath: string, config: Record<string, unknown>): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, JSON.stringify(config));
}

async function runSessionStart(
	mode: "full" | "quick" | "minimal",
	setup?: (tmpDir: string) => void,
	overrides: {
		astGrepEnsure?: () => Promise<boolean>;
		scanExports?: () => Promise<Map<string, string>>;
		getFlag?: (name: string) => boolean | string | undefined;
		projectConfig?: PiLensProjectConfig;
		globalConfig?: PiLensGlobalConfig;
		startupModeOverride?: "full" | "quick" | "minimal";
		startupModeEnv?: "full" | "quick" | "minimal" | null;
	} = {},
) {
	const env = setupTestEnvironment("pi-lens-runtime-session-");
	setup?.(env.tmpDir);
	// #810 root cause: in "full" mode with a package.json present,
	// scheduleStartupScans (clients/runtime-session.ts) fires "todo" and
	// "word-index" as fire-and-forget background tasks (setImmediate) that do
	// REAL, unmocked fs reads against env.tmpDir (collectTodoBaselineItems /
	// collectWordIndexDocs walk the project for real — unlike knip/jscpd/
	// ast-grep-exports/etc, which this test stubs out entirely). Earlier
	// versions of this helper returned as soon as handleSessionStart's own
	// promise resolved and let the caller's `finally { env.cleanup() }` run
	// immediately after — but those two tasks were often still mid-read at
	// that point, so the recursive rm raced an open file handle inside
	// tmpDir and threw EPERM on Windows (deterministic here, not a load
	// flake). Track the real in-flight-scan set via
	// markStartupScanInFlight/clearStartupScanInFlight (the same primitive
	// production code uses, `clients/runtime-coordinator.ts`) and wait for
	// "todo"/"word-index" to clear before returning, so cleanup never races
	// them. call-graph/codebase-model are deliberately excluded — they're
	// staggered 5+ seconds out by design (see taskDeferMsByName) and would
	// slow every test down for no correctness benefit; by the time they
	// fire (in a later test's turn), a stale/missing analysisRoot is a
	// harmless no-op/caught-error path, not a handle race.
	const inFlightScans = new Set<string>();
	const notify = vi.fn();
	const scanDirectory = vi.fn(() => ({ items: [] }));
	const scanFile = vi.fn((): unknown[] => []);
	const ensureTool = vi.fn(async () => null);
	const astGrepEnsure = vi.fn(overrides.astGrepEnsure ?? (async () => false));
	const scanExports = vi.fn(
		overrides.scanExports ?? (async () => new Map<string, string>()),
	);
	const biomeEnsure = vi.fn(async () => false);
	const ruffEnsure = vi.fn(async () => false);
	const knipEnsure = vi.fn(async () => false);
	const knipAnalyze = vi.fn(async () => EMPTY_KNIP_RESULT);
	const jscpdEnsure = vi.fn(async () => false);
	const depEnsure = vi.fn(async () => false);
	const resetLSPService = vi.fn();
	const dbg = vi.fn();
	const restoreStartupMode =
		overrides.startupModeEnv === null
			? (() => {
					const previous = process.env.PI_LENS_STARTUP_MODE;
					delete process.env.PI_LENS_STARTUP_MODE;
					return () => {
						if (previous === undefined) delete process.env.PI_LENS_STARTUP_MODE;
						else process.env.PI_LENS_STARTUP_MODE = previous;
					};
				})()
			: setStartupMode(overrides.startupModeEnv ?? mode);
	mockTouchFile.mockClear();

	try {
		const sessionDeps = withResidentBootstrap({
			ctxCwd: env.tmpDir,
			getFlag: (name: string) => {
				const override = overrides.getFlag?.(name);
				if (override !== undefined) return override;
				if (name === "lens-lsp") return true;
				if (name === "no-lsp") return false;
				return false;
			},
			projectConfig: overrides.projectConfig,
			globalConfig: overrides.globalConfig,
			startupModeOverride: overrides.startupModeOverride,
			notify,
			dbg,
			log: () => {},
			runtime: {
				sessionGeneration: 1,
				isCurrentSession: () => true,
				markStartupScanInFlight: (name: string) => {
					inFlightScans.add(name);
				},
				clearStartupScanInFlight: (name: string) => {
					inFlightScans.delete(name);
				},
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
				scanExports,
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
		}) as any;
		await handleSessionStart(sessionDeps);

		// The returned `cleanup` waits for the tmpDir-touching background scans
		// to settle (see the #810 comment above `inFlightScans`) before deleting
		// the directory — deliberately NOT awaited here at return time, since
		// several tests assert on the deferred/not-yet-called state of these
		// same background tasks immediately after `runSessionStart` resolves.
		const cleanup = async (): Promise<void> => {
			await vi.waitFor(
				() => {
					if (inFlightScans.has("todo") || inFlightScans.has("word-index")) {
						throw new Error("background startup scans still touching tmpDir");
					}
				},
				{ timeout: HEAVY_IO_TIMEOUT_MS },
			);
			env.cleanup();
		};

		return {
			env: { ...env, cleanup },
			repeatSessionStart: () => handleSessionStart(sessionDeps),
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

it(
	"executes the ast-grep export path and reports the returned exports",
	async () => {
		const exports = new Map([
			["readConfig", "src/config.ts"],
			["writeConfig", "src/config.ts"],
		]);
		const scanExports = vi.fn(async () => exports);
		const { env, astGrepEnsure, dbg } = await runSessionStart(
			"full",
			(tmpDir) =>
				createTempFile(
					tmpDir,
					"package.json",
					JSON.stringify({ type: "module" }),
				),
			{ astGrepEnsure: async () => true, scanExports },
		);
		try {
			await vi.waitFor(() => expect(astGrepEnsure).toHaveBeenCalled(), {
				timeout: HEAVY_IO_TIMEOUT_MS,
			});
			await vi.waitFor(() => expect(scanExports).toHaveBeenCalled(), {
				timeout: HEAVY_IO_TIMEOUT_MS,
			});
			await vi.waitFor(
				() =>
					expect(dbg).toHaveBeenCalledWith(
						expect.stringContaining("exports scan: 2 functions found"),
					),
				{ timeout: HEAVY_IO_TIMEOUT_MS },
			);
		} finally {
			await env.cleanup();
		}
	},
	TEST_BUDGET_MS,
);

it(
	"skips a disabled startup analyzer through session_start and records it",
	async () => {
		const { env, knipEnsure, dbg } = await runSessionStart(
			"full",
			(tmpDir) => {
				createTempFile(tmpDir, "package.json", JSON.stringify({}));
				createTempFile(tmpDir, "src/index.ts", "export const value = 1;\n");
			},
			{ getFlag: (name) => name === "no-knip", startupModeOverride: "full" },
		);
		try {
			await waitForCondition(
				() => dbg.mock.calls,
				(calls) =>
					calls.some(
						([message]) =>
							message === "session_start knip: skipped (disabled by config)",
					),
				{ timeoutMs: HEAVY_IO_TIMEOUT_MS },
			);
			expect(dbg).toHaveBeenCalledWith(
				"session_start knip: skipped (disabled by config)",
			);
			expect(knipEnsure).not.toHaveBeenCalled();
			expect(
				getDegradationSummary().some(
					(entry) => entry.kind === "startup-analyzer-disabled",
				),
			).toBe(true);
		} finally {
			await env.cleanup();
		}
	},
	TEST_BUDGET_MS,
);

describe("fixture-loaded startup precedence", () => {
	it("gives PI_LENS_STARTUP_MODE precedence through the scan consumer", async () => {
		const env = setupTestEnvironment("pi-lens-startup-env-precedence-");
		const globalPath = path.join(env.tmpDir, "global", "config.json");
		writeConfig(globalPath, { startup: { mode: "full" } });
		const globalConfig = loadPiLensGlobalConfig(globalPath);
		const projectConfig = loadPiLensProjectConfig(env.tmpDir);
		try {
			const result = await runSessionStart(
				"full",
				(tmpDir) => {
					createTempFile(tmpDir, "package.json", "{}");
					createTempFile(tmpDir, "src/index.ts", "export const value = 1;\n");
				},
				{
					globalConfig,
					projectConfig,
					startupModeEnv: "quick",
					getFlag: (name) =>
						resolvePiLensFlag(name, undefined, globalConfig, projectConfig),
				},
			);
			try {
				expect(result.knipAnalyze).not.toHaveBeenCalled();
				expect(result.dbg).toHaveBeenCalledWith(
					"session_start startup mode: quick",
				);
			} finally {
				await result.env.cleanup();
			}
		} finally {
			env.cleanup();
		}

		const inverse = setupTestEnvironment("pi-lens-startup-config-precedence-");
		const inversePath = path.join(inverse.tmpDir, "global", "config.json");
		writeConfig(inversePath, { startup: { mode: "quick" } });
		const inverseGlobal = loadPiLensGlobalConfig(inversePath);
		const inverseProject = loadPiLensProjectConfig(inverse.tmpDir);
		try {
			const result = await runSessionStart(
				"full",
				(tmpDir) => {
					createTempFile(tmpDir, "package.json", "{}");
					createTempFile(tmpDir, "src/index.ts", "export const value = 1;\n");
				},
				{
					globalConfig: inverseGlobal,
					projectConfig: inverseProject,
					startupModeEnv: "full",
					getFlag: (name) =>
						resolvePiLensFlag(name, undefined, inverseGlobal, inverseProject),
				},
			);
			try {
				await waitForCondition(
					() => result.knipAnalyze.mock.calls.length,
					(count) => count > 0,
					{ timeoutMs: HEAVY_IO_TIMEOUT_MS },
				);
				expect(result.dbg).toHaveBeenCalledWith(
					"session_start startup mode: full",
				);
			} finally {
				await result.env.cleanup();
			}
		} finally {
			inverse.cleanup();
		}
	});

	it("uses startup.mode config at the scan consumer", async () => {
		const env = setupTestEnvironment("pi-lens-startup-config-mode-");
		const globalConfig = loadPiLensGlobalConfig(
			path.join(env.tmpDir, "missing", "config.json"),
		);
		writeConfig(path.join(env.tmpDir, ".pi-lens.json"), {
			startup: { mode: "quick" },
		});
		const projectConfig = loadPiLensProjectConfig(env.tmpDir);
		try {
			const result = await runSessionStart(
				"full",
				(tmpDir) => {
					createTempFile(tmpDir, "package.json", "{}");
					createTempFile(tmpDir, "src/index.ts", "export const value = 1;\n");
				},
				{
					globalConfig,
					projectConfig,
					startupModeEnv: null,
					getFlag: (name) =>
						resolvePiLensFlag(name, undefined, globalConfig, projectConfig),
				},
			);
			try {
				expect(result.knipAnalyze).not.toHaveBeenCalled();
				expect(result.dbg).toHaveBeenCalledWith(
					"session_start startup mode: quick",
				);
			} finally {
				await result.env.cleanup();
			}
		} finally {
			env.cleanup();
		}
	});

	it("gives project fixtures precedence over global config for a flag and mode", async () => {
		const env = setupTestEnvironment("pi-lens-startup-project-precedence-");
		const globalPath = path.join(env.tmpDir, "global", "config.json");
		writeConfig(globalPath, {
			knip: { enabled: true },
			startup: { mode: "quick" },
		});
		writeConfig(path.join(env.tmpDir, ".pi-lens.json"), {
			knip: { enabled: false },
			startup: { mode: "full" },
		});
		const globalConfig = loadPiLensGlobalConfig(globalPath);
		const projectConfig = loadPiLensProjectConfig(env.tmpDir);
		try {
			const result = await runSessionStart(
				"full",
				(tmpDir) => createTempFile(tmpDir, "package.json", "{}"),
				{
					globalConfig,
					projectConfig,
					startupModeEnv: null,
					getFlag: (name) =>
						resolvePiLensFlag(name, undefined, globalConfig, projectConfig),
				},
			);
			try {
				expect(result.dbg).toHaveBeenCalledWith(
					"session_start startup mode: full",
				);
				await waitForCondition(
					() => result.dbg.mock.calls,
					(calls) =>
						calls.some(
							([message]) =>
								message === "session_start knip: skipped (disabled by config)",
						),
					{ timeoutMs: HEAVY_IO_TIMEOUT_MS },
				);
				expect(result.dbg).toHaveBeenCalledWith(
					"session_start knip: skipped (disabled by config)",
				);
				expect(result.knipEnsure).not.toHaveBeenCalled();
			} finally {
				await result.env.cleanup();
			}
		} finally {
			env.cleanup();
		}
	});

	it("defaults absent keys to enabled analyzers and full startup", async () => {
		const env = setupTestEnvironment("pi-lens-startup-defaults-");
		const globalConfig = loadPiLensGlobalConfig(
			path.join(env.tmpDir, "missing", "config.json"),
		);
		const projectConfig = loadPiLensProjectConfig(env.tmpDir);
		try {
			const result = await runSessionStart(
				"full",
				(tmpDir) => createTempFile(tmpDir, "package.json", "{}"),
				{
					globalConfig,
					projectConfig,
					getFlag: (name) =>
						resolvePiLensFlag(name, undefined, globalConfig, projectConfig),
				},
			);
			try {
				expect(result.dbg).toHaveBeenCalledWith(
					"session_start startup mode: full",
				);
				expect(result.dbg).not.toHaveBeenCalledWith(
					"session_start knip: skipped (disabled by config)",
				);
			} finally {
				await result.env.cleanup();
			}
		} finally {
			env.cleanup();
		}
	});

	it("keeps lens diagnostics and LSP alive when startup scans are disabled", async () => {
		const env = setupTestEnvironment("pi-lens-startup-scans-disabled-");
		writeConfig(path.join(env.tmpDir, ".pi-lens.json"), {
			startup: { mode: "full", scans: { enabled: false } },
		});
		const globalConfig = loadPiLensGlobalConfig(
			path.join(env.tmpDir, "missing", "config.json"),
		);
		const projectConfig = loadPiLensProjectConfig(env.tmpDir);
		try {
			const result = await runSessionStart(
				"full",
				(tmpDir) => createTempFile(tmpDir, "package.json", "{}"),
				{
					globalConfig,
					projectConfig,
					getFlag: (name) =>
						resolvePiLensFlag(name, undefined, globalConfig, projectConfig),
				},
			);
			try {
				expect(result.resetLSPService).toHaveBeenCalled();
				expect(result.dbg).toHaveBeenCalledWith(
					"session_start: skipping startup background scans (disabled by config)",
				);
				expect(result.dbg).not.toHaveBeenCalledWith(
					"session_start: skipping LSP initialization (disabled by config)",
				);
				expect(result.knipAnalyze).not.toHaveBeenCalled();
				expect(result.depEnsure).not.toHaveBeenCalled();
				expect(result.astGrepEnsure).not.toHaveBeenCalled();
			} finally {
				await result.env.cleanup();
			}
		} finally {
			env.cleanup();
		}
	});

	it("records startup analyzer skips once per session and re-arms after reset", async () => {
		const baseProjectConfig = loadPiLensProjectConfig(process.cwd());
		const result = await runSessionStart(
			"full",
			(tmpDir) => {
				createTempFile(tmpDir, "package.json", "{}");
				createTempFile(tmpDir, "src/index.ts", "export const value = 1;\n");
			},
			{
				projectConfig: {
					...baseProjectConfig,
					startup: { mode: "full", scans: { enabled: false } },
				},
				startupModeEnv: null,
			},
		);
		try {
			const first = getDegradationSummary().filter(
				(entry) => entry.kind === "startup-analyzer-disabled",
			);
			expect(first).toHaveLength(1);
			expect(first[0]?.latestReasons[0]?.subject).toBe("startup-scans");

			resetDegradationLedger();
			await result.repeatSessionStart();
			const second = getDegradationSummary().filter(
				(entry) => entry.kind === "startup-analyzer-disabled",
			);
			expect(second).toHaveLength(1);
			expect(second[0]?.latestReasons[0]?.subject).toBe("startup-scans");
		} finally {
			await result.env.cleanup();
		}
	});
});

describe(
	"runtime-session notifications",
	{
		timeout: TEST_BUDGET_MS,
	},
	() => {
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

				await handleSessionStart(
					withResidentBootstrap({
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
					}) as any,
				);

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

				await handleSessionStart(
					withResidentBootstrap({
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
					}) as any,
				);

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
				expect(resetLSPService).toHaveBeenCalledWith({
					fast: true,
					reason: "session_start",
				});
			} finally {
				await env.cleanup();
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
				await env.cleanup();
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
				await vi.waitFor(() => expect(scanFile).toHaveBeenCalled(), {
					timeout: HEAVY_IO_TIMEOUT_MS,
				});
			} finally {
				await env.cleanup();
			}
		});

		it("slow-FS mode skips heavyweight CLI scans but keeps the later in-process scans (#462)", async () => {
			process.env.PI_LENS_FORCE_SLOW_FS = "1";
			_resetSlowFsForTests();
			try {
				const {
					env,
					notify,
					scanFile,
					astGrepEnsure,
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
					// ast-grep-exports is scheduled AFTER the seven skipped scans in
					// scheduleStartupScans — it must still run in slow-FS mode (the
					// original guard was an early `return` that wrongly killed it and
					// call-graph/codebase-model/word-index along with knip/jscpd/etc).
					await vi.waitFor(
						() => expect(astGrepEnsure).toHaveBeenCalledTimes(1),
						{
							timeout: HEAVY_IO_TIMEOUT_MS,
						},
					);
					// todo (before the guard) also stays on.
					await vi.waitFor(() => expect(scanFile).toHaveBeenCalled(), {
						timeout: HEAVY_IO_TIMEOUT_MS,
					});

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
					await env.cleanup();
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
					await vi.waitFor(
						() => expect(astGrepEnsure).toHaveBeenCalledTimes(1),
						{
							timeout: HEAVY_IO_TIMEOUT_MS,
						},
					);
					await vi.waitFor(() => expect(scanFile).toHaveBeenCalled(), {
						timeout: HEAVY_IO_TIMEOUT_MS,
					});

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
					await env.cleanup();
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
					await vi.waitFor(() => expect(knipAnalyze).toHaveBeenCalledTimes(1), {
						timeout: HEAVY_IO_TIMEOUT_MS,
					});
					expect(jscpdEnsure).toHaveBeenCalledTimes(1);
					expect(
						notify.mock.calls.some(([msg]) =>
							String(msg).includes("PI_LENS_SUBAGENT_FULL=1"),
						),
					).toBe(false);
				} finally {
					await env.cleanup();
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
				await handleSessionStart(
					withResidentBootstrap({
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
						todoScanner: {
							scanDirectory: () => ({ items: [] }),
							scanFile: () => [],
						},
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
							analyze: async () => ({
								success: true,
								issues: [],
								unusedExports: [],
								unusedFiles: [],
								unusedDeps: [],
								unlistedDeps: [],
								summary: "skipped",
							}),
						},
						jscpdClient: {
							isAvailable: () => false,
							ensureAvailable: async () => false,
						},
						depChecker: {
							isAvailable: () => false,
							ensureAvailable: async () => false,
						},
						testRunnerClient: {
							detectRunner: () => ({ runner: "vitest", config: null }),
							runTestFile: () => ({ failed: 1, error: false }),
						},
						goClient: { isGoAvailableAsync: async () => false },
						rustClient: { isAvailableAsync: async () => false },
						ensureTool: async () => null,
						cleanStaleTsBuildInfo: () => [],
						resetDispatchBaselines: () => {},
						resetLSPService: () => {},
					}) as any,
				);
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
				await handleSessionStart(
					withResidentBootstrap({
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
						todoScanner: {
							scanDirectory: () => ({ items: [] }),
							scanFile: () => [],
						},
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
							analyze: async () => ({
								success: true,
								issues: [],
								unusedExports: [],
								unusedFiles: [],
								unusedDeps: [],
								unlistedDeps: [],
								summary: "skipped",
							}),
						},
						jscpdClient: {
							isAvailable: () => false,
							ensureAvailable: async () => false,
						},
						depChecker: {
							isAvailable: () => false,
							ensureAvailable: async () => false,
						},
						testRunnerClient: {
							detectRunner: () => ({ runner: "vitest", config: null }),
							runTestFile: () => ({ failed: 1, error: false }),
						},
						goClient: { isGoAvailableAsync: async () => false },
						rustClient: { isAvailableAsync: async () => false },
						ensureTool: async () => null,
						cleanStaleTsBuildInfo: () => [],
						resetDispatchBaselines: () => {},
						resetLSPService: () => {},
					}) as any,
				);
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
				await handleSessionStart(
					withResidentBootstrap({
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
						todoScanner: {
							scanDirectory: () => ({ items: [] }),
							scanFile: () => [],
						},
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
							analyze: async () => ({
								success: true,
								issues: [],
								unusedExports: [],
								unusedFiles: [],
								unusedDeps: [],
								unlistedDeps: [],
								summary: "skipped",
							}),
						},
						jscpdClient: {
							isAvailable: () => false,
							ensureAvailable: async () => false,
						},
						depChecker: {
							isAvailable: () => false,
							ensureAvailable: async () => false,
						},
						testRunnerClient: {
							detectRunner: () => ({ runner: "vitest", config: null }),
							runTestFile: () => ({ failed: 1, error: false }),
						},
						goClient: { isGoAvailableAsync: async () => false },
						rustClient: { isAvailableAsync: async () => false },
						ensureTool: async () => null,
						cleanStaleTsBuildInfo: () => [],
						resetDispatchBaselines: () => {},
						resetLSPService: () => {},
					}) as any,
				);
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
				await vi.waitFor(() => expect(depEnsure).toHaveBeenCalledTimes(1), {
					timeout: HEAVY_IO_TIMEOUT_MS,
				});
				await vi.waitFor(() => expect(astGrepEnsure).toHaveBeenCalledTimes(1), {
					timeout: HEAVY_IO_TIMEOUT_MS,
				});

				// biome is covered by startup preinstall; ast-grep/knip/jscpd by startup
				// scans. ruff is irrelevant for this JS/TS-only project.
				expect(biomeEnsure).not.toHaveBeenCalled();
				expect(ruffEnsure).not.toHaveBeenCalled();
				expect(knipEnsure).not.toHaveBeenCalled();
				expect(knipAnalyze).toHaveBeenCalledTimes(1);
				expect(jscpdEnsure).toHaveBeenCalledTimes(1);
			} finally {
				await env.cleanup();
			}
		});
	},
);

// #1609 review F1: sweepOwnStagingFiles never recurses, so the session_start
// orphan sweep must list every atomic-write-writing directory explicitly.
// clients/installer/index.ts writes downloaded tool binaries into
// getGlobalPiLensDir()/bin and /tools (GITHUB_BIN_DIR / TOOLS_DIR) — a kill
// mid-install (this PR's own motivating scenario) can leave an orphaned
// staging file behind there, and unique pid-thread-seq staging names mean
// repeated kills ACCUMULATE orphans rather than overwriting one. Pre-fix,
// runtime-session.ts's sweep call omitted both directories entirely, so an
// orphan planted there was never reaped by session_start.
describe(
	"session_start orphan-stage sweep (#1609 review F1)",
	{
		timeout: TEST_BUDGET_MS,
	},
	() => {
		it("reaps a dead-pid orphan staging file in the installer's bin/ and tools/ dirs", async () => {
			const globalDir = getGlobalPiLensDir();
			const binDir = path.join(globalDir, "bin");
			const toolsDir = path.join(globalDir, "tools");
			fs.mkdirSync(binDir, { recursive: true });
			fs.mkdirSync(toolsDir, { recursive: true });
			const deadPid = findDeadPid();
			const binOrphan = path.join(binDir, `ktlint.tmp-${deadPid}-0-1`);
			const toolsOrphan = path.join(
				toolsDir,
				`package.json.tmp-${deadPid}-0-2`,
			);
			fs.writeFileSync(binOrphan, "orphan binary bytes");
			fs.writeFileSync(toolsOrphan, "orphan package.json bytes");

			const { env } = await runSessionStart("quick");
			try {
				// The sweep is fire-and-forget (void ...).catch(...)) inside
				// handleSessionStart, so poll for the orphans' removal rather than
				// asserting synchronously after the call returns.
				await vi.waitFor(
					() => {
						if (fs.existsSync(binOrphan) || fs.existsSync(toolsOrphan)) {
							throw new Error("orphan staging files not yet reaped");
						}
					},
					{ timeout: HEAVY_IO_TIMEOUT_MS },
				);
			} finally {
				fs.rmSync(binDir, { recursive: true, force: true });
				fs.rmSync(toolsDir, { recursive: true, force: true });
				await env.cleanup();
			}
		});
	},
);
