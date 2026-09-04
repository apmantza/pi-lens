/**
 * #1910: the tier-3 cascade outstanding-touch registry and its sweep-scoped
 * `_expiredSinceLastSweep`/`_evictedSinceLastSweep` counters (#1899) were never
 * wired into `handleSessionStart` — a session replacement inherited the prior
 * session's outstanding touches, and a stray eviction/expiry landing between a
 * sweep and the boundary attributed its count to the NEXT session's first
 * reconcile gauge.
 *
 * This drives the REAL handler (never calling `resetCascadeTierSessionState`
 * directly) so the wiring itself — not just the reset function in isolation —
 * is under test. `tests/support/session-state-registry.ts`'s probe already
 * proves the reset function re-arms the state; this file proves
 * `handleSessionStart` actually reaches it, and that a concurrent secondary
 * (which never reaches `handleSessionStart` at all — the #473 guard in
 * index.ts) does not.
 */

import { withResidentBootstrap } from "../support/bootstrap-access.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { removeTempDirSync, setupTestEnvironment } from "./test-utils.js";
import { makeLspServiceDouble } from "../support/lsp-service-double.js";

// Dynamically imported below (never a static top-level import): a static
// `import ... from "../../clients/runtime-session.js"` pulls in
// clients/lsp/cascade-tier.js as part of the SAME module-graph evaluation
// that runs BEFORE this file's own top-level `const logCascade = vi.fn()`
// below executes, which is a TDZ crash the moment the hoisted
// `vi.mock("../../clients/cascade-logger.js", ...)` factory tries to read it.
type HandleSessionStart =
	typeof import("../../clients/runtime-session.js").handleSessionStart;

const registerQuietWindowTask = vi.fn();
const logCascade = vi.fn();

vi.mock("../../clients/quiet-window.js", () => ({
	registerQuietWindowTask,
}));
vi.mock("../../clients/cascade-logger.js", () => ({
	logCascade,
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

vi.mock("../../clients/lsp/config.js", () => ({
	loadLSPConfig: vi.fn().mockResolvedValue({}),
	initLSPConfig: vi.fn().mockResolvedValue(undefined),
	getServerInitOverride: vi.fn().mockReturnValue(undefined),
}));

vi.mock("../../clients/lsp/index.js", () => ({
	getLSPService: vi.fn(() => makeLspServiceDouble()),
}));

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

/** Mirrors `MAX_OUTSTANDING_TOUCHES` in clients/lsp/cascade-tier.ts. */
const CAP = 256;
/** Mirrors `OUTSTANDING_TOUCH_MAX_AGE_MS` in clients/lsp/cascade-tier.ts. */
const MAX_AGE_MS = 15 * 60_000;

function sweepGauge(): { phase: string; metadata: Record<string, unknown> } {
	const row = logCascade.mock.calls
		.map((call) => call[0])
		.find((candidate) => candidate?.phase === "cascade_tier3_reconcile");
	if (!row) throw new Error("no cascade_tier3_reconcile record was written");
	return row;
}

describe("cascade tier-3 registry is reset at session_start (#1910)", () => {
	let tmpDir: string;
	let handleSessionStart: HandleSessionStart;

	beforeEach(async () => {
		vi.clearAllMocks();
		tmpDir = setupTestEnvironment("pi-lens-cascade-tier-reset-").tmpDir;
		const cascadeTier = await import("../../clients/lsp/cascade-tier.js");
		cascadeTier._resetOutstandingCascadeTouchesForTests();
		cascadeTier._resetCascadeTierReconcileRegistrationForTests();
		({ handleSessionStart } = await import("../../clients/runtime-session.js"));
	});

	afterEach(() => {
		removeTempDirSync(tmpDir);
	});

	it("clears outstanding touches and the expired/evicted counters through the real handler", async () => {
		const cascadeTier = await import("../../clients/lsp/cascade-tier.js");
		const base = Date.now();

		// Arm the registry, and both since-last-sweep counters: one ancient
		// touch (pruned by age on the next record) and CAP+1 fresh touches (the
		// last record trips the size cap and evicts the oldest survivor).
		cascadeTier.recordOutstandingCascadeTouch({
			filePath: `${tmpDir}/ancient.ts`,
			serverId: "typescript",
			touchedAt: base - MAX_AGE_MS - 1,
		});
		for (let i = 0; i <= CAP; i++) {
			cascadeTier.recordOutstandingCascadeTouch({
				filePath: `${tmpDir}/f${i}.ts`,
				serverId: "typescript",
				touchedAt: base - CAP + i,
			});
		}
		expect(
			cascadeTier._getOutstandingCascadeTouchesForTests().length,
		).toBeGreaterThan(0);

		// Never call resetCascadeTierSessionState directly — the whole point is
		// to prove handleSessionStart itself reaches it.
		await handleSessionStart(makeDeps(tmpDir));

		expect(cascadeTier._getOutstandingCascadeTouchesForTests()).toEqual([]);

		// Confirm the SWEEP-SCOPED counters were cleared too, not just the map:
		// register the reconcile task and run one sweep, and read what it wrote.
		cascadeTier.registerCascadeTierReconcileTask(
			() =>
				({
					getWarmClientForFile: vi.fn().mockResolvedValue(undefined),
				}) as never,
		);
		const task = registerQuietWindowTask.mock
			.calls[0][1] as () => Promise<void>;
		await task();
		expect(sweepGauge().metadata).toMatchObject({
			count: 0,
			expired: 0,
			evicted: 0,
		});
	});

	// The "a concurrent secondary must NOT reset" half is proved at the
	// index.ts layer, where the #473 primary/secondary decision actually lives
	// — see tests/index-integration.test.ts's "primary session_start clears the
	// cascade tier-3 registry, a concurrent secondary's does not".
});
