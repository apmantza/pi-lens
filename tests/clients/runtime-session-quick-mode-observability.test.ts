/**
 * #1911: quick-mode `session_start` skips several slow probes silently — the
 * `session_start: quick mode active - skipping...` debug line names them, but
 * nothing bounded or structured said so. In test mode `dbg()` is suppressed
 * entirely (`clients/env-utils.ts`'s `isTestMode`), so that debug line was
 * never even a durable record in production either way — absence of the
 * skipped work and absence of the LOGGING read identically in latency.log.
 *
 * This pins the structured twin: one `session_start_skipped_steps` latency
 * record on the quick path, naming the skipped step set, and its ABSENCE on
 * the full path (where those steps actually run instead of being skipped).
 */

import { withResidentBootstrap } from "../support/bootstrap-access.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LatencyEntry } from "../../clients/latency-logger.js";
import { makeLspServiceDouble } from "../support/lsp-service-double.js";

const latencyEntries = vi.hoisted(() => [] as LatencyEntry[]);

vi.mock("../../clients/latency-logger.js", async (importActual) => ({
	...(await importActual<typeof import("../../clients/latency-logger.js")>()),
	logLatency: (entry: LatencyEntry) => latencyEntries.push(entry),
}));

vi.mock("../../clients/lsp/config.js", () => ({
	loadLSPConfig: vi.fn().mockResolvedValue({}),
	initLSPConfig: vi.fn().mockResolvedValue(undefined),
	getServerInitOverride: vi.fn().mockReturnValue(undefined),
}));

vi.mock("../../clients/lsp/index.js", () => ({
	getLSPService: vi.fn(() => makeLspServiceDouble()),
}));

vi.mock("../../clients/safe-spawn.js", () => ({
	safeSpawn: vi.fn(() => ({ stdout: "", stderr: "", status: 1 })),
	safeSpawnAsync: vi.fn(async () => ({ stdout: "", stderr: "", status: 1 })),
	resetSafeSpawnWindowsCommandCache: vi.fn(),
}));

vi.mock("../../clients/installer/index.js", () => ({
	ensureTool: vi.fn(async () => undefined),
	resetResolvedPathCache: vi.fn(),
	isSpawnableCommand: vi.fn(async () => false),
	resetPathWalkMemo: vi.fn(),
}));

import { handleSessionStart } from "../../clients/runtime-session.js";
import { removeTempDirSync, setupTestEnvironment } from "./test-utils.js";

// The full path runs a REAL (unmocked) handleSessionStart body, same as
// tests/index-integration.test.ts's integration cases — vitest's default
// 5000ms timed out once in six under batch contention. Same constant name and
// value as that file's INTEGRATION_TIMEOUT_MS.
const INTEGRATION_TIMEOUT_MS = 45_000;

function setStartupMode(mode: "full" | "quick"): () => void {
	const prev = process.env.PI_LENS_STARTUP_MODE;
	process.env.PI_LENS_STARTUP_MODE = mode;
	return () => {
		if (prev === undefined) delete process.env.PI_LENS_STARTUP_MODE;
		else process.env.PI_LENS_STARTUP_MODE = prev;
	};
}

function makeDefaultRuntime() {
	return {
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
	};
}

function makeDeps(ctxCwd: string) {
	return withResidentBootstrap({
		ctxCwd,
		getFlag: () => false,
		notify: vi.fn(),
		dbg: () => {},
		log: () => {},
		runtime: makeDefaultRuntime(),
		metricsClient: { reset: () => {} },
		cacheManager: { writeCache: () => {}, readCache: () => null },
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
		ensureTool: vi.fn(async () => null),
		cleanStaleTsBuildInfo: () => [],
		resetDispatchBaselines: () => {},
		resetLSPService: () => {},
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
	}) as any;
}

function skippedStepsRecords(): LatencyEntry[] {
	return latencyEntries.filter(
		(entry) => entry.phase === "session_start_skipped_steps",
	);
}

describe("quick-mode session_start skip observability (#1911)", () => {
	let tmpDir: string;
	let restoreStartupMode: () => void;

	beforeEach(() => {
		vi.clearAllMocks();
		latencyEntries.length = 0;
		tmpDir = setupTestEnvironment("pi-lens-quick-mode-obs-").tmpDir;
	});

	afterEach(() => {
		restoreStartupMode?.();
		removeTempDirSync(tmpDir);
	});

	it("emits a bounded session_start_skipped_steps record naming the skipped steps on the quick path", async () => {
		restoreStartupMode = setStartupMode("quick");

		await handleSessionStart(makeDeps(tmpDir));

		const records = skippedStepsRecords();
		expect(records).toHaveLength(1);
		expect(records[0]).toEqual(
			expect.objectContaining({
				type: "phase",
				phase: "session_start_skipped_steps",
				filePath: tmpDir,
				durationMs: 0,
				metadata: expect.objectContaining({
					mode: "quick",
					steps: expect.arrayContaining([
						"slow_tool_probes",
						"language_profiling",
						"tool_preinstall",
						"startup_scans",
						"error_debt_baseline",
					]),
				}),
			}),
		);
	});

	it(
		"never emits the record on the full path, where those steps actually run instead of being skipped",
		async () => {
			restoreStartupMode = setStartupMode("full");

			await handleSessionStart(makeDeps(tmpDir));

			expect(skippedStepsRecords()).toEqual([]);
		},
		INTEGRATION_TIMEOUT_MS,
	);
});
