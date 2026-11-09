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
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import { removeTempDirSync, setupTestEnvironment } from "./test-utils.js";
import { installLspServiceDouble } from "../support/lsp-service-seam.js";
import { resetLSPConfigStateForTests } from "../../clients/lsp/config.js";
import { pinFixtureHome } from "./test-utils.js";
import { withEnv } from "../support/with-env.js";

type HandleSessionStart =
	typeof import("../../clients/runtime-session.js").handleSessionStart;

vi.mock("../../clients/safe-spawn.js", () => ({
	safeSpawn: vi.fn(() => ({ stdout: "", stderr: "", status: 1 })),
	safeSpawnAsync: vi.fn(async () => ({ stdout: "", stderr: "", status: 1 })),
	resetSafeSpawnWindowsCommandCache: vi.fn(),
}));

function makeDeps(ctxCwd: string) {
	return withResidentBootstrap({
		ctxCwd,
		getFlag: () => false,
		notify: vi.fn(),
		dbg: () => {},
		log: () => {},
		runtime: new RuntimeCoordinator(),
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

describe("cascade tier-3 registry is reset at session_start (#1910)", () => {
	let tmpDir: string;
	let handleSessionStart: HandleSessionStart;
	let restoreEnv: (() => void) | undefined;

	beforeEach(async () => {
		// The real config loader walks up from the session cwd to HOME (#4709);
		// a pinned fixture HOME keeps that read off the maintainer's home.
		pinFixtureHome("runtime-session-cascade-tier-reset");
		// The real installer is no longer mocked: no session-start path may
		// reach a download from this case.
		restoreEnv = withEnv({ PI_LENS_DISABLE_TOOL_INSTALL: "1" });
		await installLspServiceDouble();
		tmpDir = setupTestEnvironment("pi-lens-cascade-tier-reset-").tmpDir;
		const cascadeTier = await import("../../clients/lsp/cascade-tier.js");
		cascadeTier._resetOutstandingCascadeTouchesForTests();
		cascadeTier._resetCascadeTierReconcileRegistrationForTests();
		({ handleSessionStart } = await import("../../clients/runtime-session.js"));
	});

	afterEach(() => {
		restoreEnv?.();
		restoreEnv = undefined;
		resetLSPConfigStateForTests();
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
		// read them where the next sweep's reconcile gauge reads them.
		expect(cascadeTier._getCascadeTierSweepCountersForTests()).toEqual({
			expired: 0,
			evicted: 0,
		});
	});

	// The "a concurrent secondary must NOT reset" half is proved at the
	// index.ts layer, where the #473 primary/secondary decision actually lives
	// — see tests/index-integration.test.ts's "primary session_start clears the
	// cascade tier-3 registry, a concurrent secondary's does not".
});
