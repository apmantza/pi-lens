/**
 * Guards the pi-lens **session_start hook** budget by asserting the self-reported
 * "session_start total: Xms" value that handleSessionStart() emits via dbg.
 *
 * Scope note: this covers the hook's synchronous work only. It does NOT capture
 * the extension load/transpile cost — that is paid before any pi-lens code runs
 * (pi's jiti loader), and is logged separately as "pi-lens loaded: <ms>ms ...
 * (from dist|source)" (`clients/startup-timing.ts`). That load cost — the #182
 * win — is guarded end-to-end by the CI install-test step ("entry loads from
 * precompiled dist") and structurally by `tests/packaging.test.ts`. So total
 * cold-start = load time (those guards) + session_start hook (this file).
 *
 * We assert the number pi-lens itself logs — the same figure visible in
 * production session logs — rather than raw wall-clock time of the test.
 * Background tasks (scans, tool probes) fire-and-forget and are not counted.
 *
 * These are regression guards, not tight perf benchmarks. If they start
 * flaking, bump the budget — but investigate first, because a 2× regression
 * usually means something synchronous crept onto the hot path.
 */

import * as os from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleSessionStart } from "../../clients/runtime-session.js";
import type { LatencyEntry } from "../../clients/latency-logger.js";
import { createTempFile, setupTestEnvironment } from "./test-utils.js";

const latencyEntries = vi.hoisted(() => [] as LatencyEntry[]);

vi.mock("../../clients/latency-logger.js", async (importActual) => ({
	...(await importActual<typeof import("../../clients/latency-logger.js")>()),
	logLatency: (entry: LatencyEntry) => latencyEntries.push(entry),
}));

// Measured mocked-path cost is single-digit ms (all clients/tools stubbed
// unavailable, no real FS/process work) — the wide margin below is headroom
// for scheduler jitter under full-suite parallel-fork contention, not a
// reflection of real cost. Seen tripping at ~138-157ms under load despite
// that; retry soaks rare spikes the same way `cascade-graph-occupancy.test.ts`
// does. A genuine regression (e.g. an accidental sync `fs.readdirSync` over a
// big tree sneaking onto this hot path) would still blow even this budget.
const QUICK_MODE_BUDGET_MS = 500;
const FULL_MODE_BUDGET_MS = 500;

/** Extract the self-reported ms from "session_start total: Xms ..." dbg lines. */
function extractReportedMs(dbgCalls: string[]): number | null {
	for (const msg of dbgCalls) {
		const m = /session_start total:\s*(\d+)ms/.exec(msg);
		if (m) return Number(m[1]);
	}
	return null;
}

function setStartupMode(mode: "full" | "quick"): () => void {
	const prev = process.env.PI_LENS_STARTUP_MODE;
	process.env.PI_LENS_STARTUP_MODE = mode;
	return () => {
		if (prev === undefined) delete process.env.PI_LENS_STARTUP_MODE;
		else process.env.PI_LENS_STARTUP_MODE = prev;
	};
}

function makeDeps(ctxCwd: string, dbg: (msg: string) => void = () => {}) {
	return {
		ctxCwd,
		getFlag: (_name: string) => false,
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
		cacheManager: {
			writeCache: () => {},
			readCache: () => null,
		},
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
		ensureTool: async () => null,
		cleanStaleTsBuildInfo: () => [],
		resetDispatchBaselines: () => {},
		resetLSPService: () => {},
	} as any;
}

afterEach(() => {
	delete process.env.PI_LENS_STARTUP_MODE;
});

describe("startup overhead — interactive path regression guard", () => {
	beforeEach(() => {
		latencyEntries.length = 0;
	});

	it(
		`quick mode self-reports within ${QUICK_MODE_BUDGET_MS}ms`,
		{ retry: 2 },
		async () => {
			const env = setupTestEnvironment("pi-lens-overhead-quick-");
			const restoreMode = setStartupMode("quick");
			const dbgLog: string[] = [];

			try {
				await handleSessionStart(
					makeDeps(env.tmpDir, (msg) => dbgLog.push(msg)),
				);

				const reported = extractReportedMs(dbgLog);
				expect(reported).not.toBeNull();
				expect(reported).toBeLessThan(QUICK_MODE_BUDGET_MS);
			} finally {
				env.cleanup();
				restoreMode();
			}
		},
	);

	it("quick mode emits attributable phases whose top-level durations account for total", async () => {
		const env = setupTestEnvironment("pi-lens-overhead-records-");
		const restoreMode = setStartupMode("quick");
		const firedAt = Date.now() - 3;

		try {
			await handleSessionStart({
				...makeDeps(env.tmpDir),
				sessionStartFiredAt: firedAt,
				handlerEnteredAt: firedAt + 2,
				bootstrapClientsStartedAt: firedAt,
				bootstrapClientsDurationMs: 1,
				sessionReason: "startup",
				extensionLoadedAt: 100,
				sessionStartMonotonicAt: 125,
				emitHostReadyDelay: true,
			});

			const phases = new Map(
				latencyEntries.map((entry) => [entry.phase, entry]),
			);
			// #1019: session_start_log_cleanup is intentionally NOT asserted here —
			// it was deferred off the critical path (setImmediate) and so is not
			// emitted synchronously within handleSessionStart's awaited chain.
			expect([...phases.keys()]).toEqual(
				expect.arrayContaining([
					"bootstrap_clients_load",
					"session_start_prehandler",
					"session_start_runtime_reset",
					"session_start_sequence_read",
					"session_start_snapshot_load",
					"session_start_total",
					"host_ready_delay",
				]),
			);
			expect(phases.get("host_ready_delay")?.durationMs).toBe(25);
			expect(phases.get("host_ready_delay")?.metadata).toEqual({
				hostStallSuspected: false,
				sessionStart: "first-process-session",
				reason: "startup",
			});
			expect(phases.get("session_start_total")?.metadata).toEqual({
				mode: "quick",
				reason: "startup",
				sameRoot: "unknown",
			});
			expect(phases.get("session_start_sequence_read")?.metadata).toEqual(
				expect.objectContaining({ entries: expect.any(Number) }),
			);
			expect(phases.get("session_start_snapshot_load")?.metadata).toEqual(
				expect.objectContaining({
					bytes: expect.any(Number),
					fresh: expect.any(Boolean),
				}),
			);

			const topLevel = [
				"session_start_prehandler",
				"session_start_runtime_reset",
				"session_start_sequence_read",
				"session_start_snapshot_load",
			];
			const childSum = topLevel.reduce(
				(sum, phase) => sum + (phases.get(phase)?.durationMs ?? 0),
				0,
			);
			expect(
				Math.abs(
					(phases.get("session_start_total")?.durationMs ?? 0) - childSum,
				),
			).toBeLessThanOrEqual(10);
		} finally {
			env.cleanup();
			restoreMode();
		}
	});

	it("home-directory full mode does not source-scan the home tree", async () => {
		const restoreMode = setStartupMode("full");
		const dbgLog: string[] = [];

		try {
			await handleSessionStart(
				makeDeps(os.homedir(), (msg) => dbgLog.push(msg)),
			);

			const reported = extractReportedMs(dbgLog);
			expect(reported).not.toBeNull();
			expect(reported).toBeLessThan(FULL_MODE_BUDGET_MS);
			expect(dbgLog).toContainEqual(
				expect.stringContaining("warmCaches=false, reason=home-dir"),
			);
		} finally {
			restoreMode();
		}
	});

	it("emits host-ready delay only for the first anchored session start", async () => {
		const env = setupTestEnvironment("pi-lens-overhead-once-");
		const restoreMode = setStartupMode("quick");
		try {
			await handleSessionStart({
				...makeDeps(env.tmpDir),
				extensionLoadedAt: 100,
				sessionStartMonotonicAt: 30_101,
				emitHostReadyDelay: true,
			});
			await handleSessionStart({
				...makeDeps(env.tmpDir),
				extensionLoadedAt: 100,
				sessionStartMonotonicAt: 90_101,
				emitHostReadyDelay: false,
			});

			expect(
				latencyEntries.filter((e) => e.phase === "host_ready_delay"),
			).toHaveLength(1);
		} finally {
			env.cleanup();
			restoreMode();
		}
	});

	it.each([
		[30_000, false],
		[30_001, true],
	])(
		"marks a %ims host-ready delay as stalled=%s",
		async (durationMs, stalled) => {
			const env = setupTestEnvironment("pi-lens-overhead-boundary-");
			const restoreMode = setStartupMode("quick");
			try {
				await handleSessionStart({
					...makeDeps(env.tmpDir),
					extensionLoadedAt: 100,
					sessionStartMonotonicAt: 100 + durationMs,
					emitHostReadyDelay: true,
				});
				const entry = latencyEntries.find(
					(e) => e.phase === "host_ready_delay",
				);
				expect(entry?.durationMs).toBe(durationMs);
				expect(entry?.metadata).toEqual(
					expect.objectContaining({ hostStallSuspected: stalled }),
				);
			} finally {
				env.cleanup();
				restoreMode();
			}
		},
	);

	it(`full mode self-reports within ${FULL_MODE_BUDGET_MS}ms`, async () => {
		const env = setupTestEnvironment("pi-lens-overhead-full-");
		const restoreMode = setStartupMode("full");
		const dbgLog: string[] = [];

		createTempFile(
			env.tmpDir,
			"package.json",
			JSON.stringify({ name: "test-project", type: "module" }),
		);
		createTempFile(env.tmpDir, "src/index.ts", "export const x = 1;\n");

		try {
			await handleSessionStart({
				...makeDeps(env.tmpDir, (msg) => dbgLog.push(msg)),
				extensionLoadedAt: 100,
				sessionStartMonotonicAt: 125,
				emitHostReadyDelay: true,
			});

			const reported = extractReportedMs(dbgLog);
			expect(reported).not.toBeNull();
			expect(reported).toBeLessThan(FULL_MODE_BUDGET_MS);
			expect(
				latencyEntries.find((entry) => entry.phase === "host_ready_delay"),
			).toMatchObject({
				durationMs: 25,
				metadata: { sessionStart: "first-process-session" },
			});
		} finally {
			env.cleanup();
			restoreMode();
		}
	});
});
