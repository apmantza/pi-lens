import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { endMockSessions } from "./support/mock-session-teardown.js";
import { createPiMock } from "./support/pi-mock.js";
import { getCurrentPhase, phaseStarted } from "../clients/latency-logger.js";

// Wiring guards for the #1122 loop_block probe fix. These live at the index.ts
// turn_end seam (not the pure classifier) because the two things that broke —
// and could silently re-break in a refactor — are wiring facts:
//   (a) turn_end MUST call resetEventLoopMonitor(); the headline bug was that
//       reset was NEVER wired, so histogram.max was lifetime-cumulative.
//   (b) a suspectSystemStall sample MUST NOT advance the genuine-block
//       high-water, or a machine freeze permanently silences later real blocks.
// Both fail on pre-fix master: (a) master never calls reset; (b) master raises
// the high-water unconditionally, so the follow-up genuine block is suppressed.

// Controllable event-loop stats + spyable reset. shouldLogWorstBlock stays real
// so the gating logic under test is the production one.
let statsToReturn: unknown;
const resetSpy = vi.fn();
vi.mock("../clients/event-loop-monitor.js", async (importActual) => {
	const actual =
		await importActual<typeof import("../clients/event-loop-monitor.js")>();
	return {
		...actual,
		startEventLoopMonitor: vi.fn(),
		resetEventLoopMonitor: resetSpy,
		getEventLoopStats: () => statsToReturn,
	};
});

// Capture latency writes without touching disk; provide the attribution seam.
const latencyCalls: Array<Record<string, unknown>> = [];
// #1723 (redesigned after review): controllable in-flight-phase-window stand-in
// — undefined by default (no bracket overlaps the sampled block window),
// overridable per test to simulate `getPhaseForWindow` finding a live OR
// recently-closed bracket that overlaps the block's own time window.
let phaseForWindowToReturn:
	| {
			phase: string;
			startedAt: string;
			stillRunning: boolean;
			elapsedMs: number;
	  }
	| undefined;
vi.mock("../clients/latency-logger.js", async (importActual) => {
	const actual =
		await importActual<typeof import("../clients/latency-logger.js")>();
	return {
		...actual,
		logLatency: (entry: Record<string, unknown>) => {
			latencyCalls.push(entry);
		},
		getLastLoggedPhase: () => ({
			phase: "graph_build",
			ts: "2026-08-07T00:00:00.000Z",
		}),
		getPhaseForWindow: () => phaseForWindowToReturn,
	};
});

// Heavy turn_end tail is separately tested; stub to keep this a wiring check.
vi.mock("../clients/bootstrap.js", async () => {
	const { bootstrapSeamMock } = await import("./support/bootstrap-mock.js");
	return bootstrapSeamMock(async () => ({
		metricsClient: { reset: () => {} },
		knipClient: { isAvailable: () => false },
		depChecker: { isAvailable: () => false },
		testRunnerClient: { detectRunner: () => null },
		deadCodeClients: [],
	}));
});
vi.mock("../clients/runtime-turn.js", () => ({
	handleTurnEnd: vi.fn(async () => undefined),
	cancelLSPIdleReset: vi.fn(),
}));

const loopBlocks = () => latencyCalls.filter((e) => e.phase === "loop_block");

const turnCtx = {
	cwd: process.cwd(),
	ui: {
		notify: vi.fn(),
		setStatus: () => {},
		theme: { fg: (_c: string, s: string) => s },
	},
};

async function fireTurnEnd() {
	const { default: registerExtension } = await import("../index.js");
	const mock = createPiMock();
	registerExtension(mock.asExtensionAPI() as never);
	const turnEnd = mock.getHandlers("turn_end")[0];
	expect(turnEnd).toBeTypeOf("function");
	await turnEnd?.({}, turnCtx as never);
	return mock;
}

// #1772: case (a) pays a COLD `import("../index.js")` after
// `vi.resetModules()` in `beforeEach`. Cases (b) and (c) also resetModules,
// but their imports land on vitest's already-warm transform cache from case
// (a)'s run, so they only pay re-execution, not re-transformation — that is
// why only (a) blows the timeout below.
//
// resetModules is not here for "isolation" in the abstract: the actual
// per-test isolation comes from the beforeEach mock clears
// (`resetSpy.mockClear()`, `statsToReturn`/`latencyCalls` reset). What
// resetModules buys is avoiding ORDER-COUPLING: index.ts keeps turn-scoped
// high-water state at module scope (the #1723 subject case (c) exercises),
// so hoisting the import to `beforeAll` would let case (c)'s `worstSoFar`
// assertions silently depend on whatever high-water case (b) left behind,
// instead of each test starting from a clean module. So the fix here is a
// timeout budget, not a hoisted import (matching #1764's
// instance-reaper-prune-concurrency fix and this repo's HEAVY_IO_TIMEOUT_MS
// convention, tests/clients/ast-grep-rule-precedence-followups.test.ts:210).
//
// Solo runs on a busy box measured case (a)'s cold-import cost up to 9.2s,
// already over vitest's 5000ms default (timeout, not an assertion failure —
// it passes every time once given room); #1743's and #1761's controlled A/B
// comparisons showed master fails at the same or higher rate than feature
// branches, so this is pre-existing and environmental, not a regression. 30s
// matches the existing convention and leaves ~3.2x headroom over the worst
// solo run observed.
const LOOP_BLOCK_WIRING_TIMEOUT_MS = 30_000;

describe(
	"index turn_end loop_block wiring (#1122)",
	{ timeout: LOOP_BLOCK_WIRING_TIMEOUT_MS },
	() => {
		beforeEach(() => {
			vi.resetModules();
			latencyCalls.length = 0;
			resetSpy.mockClear();
			statsToReturn = undefined;
			phaseForWindowToReturn = undefined;
		});
		afterEach(async () => {
			// #5146: case (f) starts a session; end it before the mocks clear.
			await endMockSessions();
			vi.clearAllMocks();
		});

		it("(a) calls resetEventLoopMonitor at turn_end so the window is per-turn", async () => {
			statsToReturn = {
				maxMs: 0,
				p99Ms: 0,
				meanMs: 0,
				windowWallMs: 0,
				windowCpuMs: 0,
				suspectSystemStall: false,
			};
			await fireTurnEnd();
			// Fails on master: master's turn_end never resets the histogram.
			expect(resetSpy).toHaveBeenCalledTimes(1);
		});

		it("(b) a suspectSystemStall block does not raise the high-water, so a later genuine block still logs", async () => {
			// resetModules is per-test, so re-import once and drive two turns against
			// the SAME module instance to exercise the cross-turn high-water.
			const { default: registerExtension } = await import("../index.js");
			const mock = createPiMock();
			registerExtension(mock.asExtensionAPI() as never);
			const turnEnd = mock.getHandlers("turn_end")[0];

			// Turn 1: a 300s "block" tagged as a system stall.
			statsToReturn = {
				maxMs: 300000,
				p99Ms: 0,
				meanMs: 0,
				windowWallMs: 300000,
				windowCpuMs: 200,
				suspectSystemStall: true,
			};
			await turnEnd?.({}, turnCtx as never);

			// Turn 2: a genuine 5s block, far below the stall but a real worst.
			statsToReturn = {
				maxMs: 5000,
				p99Ms: 0,
				meanMs: 0,
				windowWallMs: 8000,
				windowCpuMs: 6000,
				suspectSystemStall: false,
			};
			await turnEnd?.({}, turnCtx as never);

			const logged = loopBlocks();
			// The stall logged (tagged) but did NOT poison the high-water, so the
			// genuine 5s block logged too. On master the stall sets the high-water to
			// 300000 and the 5s block is suppressed → only ONE loop_block.
			expect(logged).toHaveLength(2);
			expect(logged[0].durationMs).toBe(300000);
			expect(
				(logged[0].metadata as Record<string, unknown>).suspectSystemStall,
			).toBe(true);
			expect(logged[1].durationMs).toBe(5000);
			expect(
				(logged[1].metadata as Record<string, unknown>).suspectSystemStall,
			).toBe(false);
			// Attribution is carried through.
			expect((logged[1].metadata as Record<string, unknown>).lastPhase).toBe(
				"graph_build",
			);
		});

		it("(c) #1723: logs a block below the session's prior worst, not only new maxima", async () => {
			const { default: registerExtension } = await import("../index.js");
			const mock = createPiMock();
			registerExtension(mock.asExtensionAPI() as never);
			const turnEnd = mock.getHandlers("turn_end")[0];

			// Turn 1: a genuine 15s block sets the session high-water.
			statsToReturn = {
				maxMs: 15000,
				p99Ms: 0,
				meanMs: 0,
				windowWallMs: 16000,
				windowCpuMs: 15500,
				suspectSystemStall: false,
			};
			await turnEnd?.({}, turnCtx as never);

			// Turn 2: a genuine 5s block — well above the 60ms floor, but far below
			// the 15000ms high-water plus its 25ms delta. Pre-#1723 code gates the
			// LOG itself on "beats the high-water", so this block was silently
			// dropped: shouldLogWorstBlock(5000, 15000) is false. That is exactly the
			// gap #1723 reports — every sub-maximum block after a session's first
			// large one was invisible, so a loop_block-vs-pull-timeout correlation
			// couldn't be checked.
			statsToReturn = {
				maxMs: 5000,
				p99Ms: 0,
				meanMs: 0,
				windowWallMs: 6000,
				windowCpuMs: 5500,
				suspectSystemStall: false,
			};
			await turnEnd?.({}, turnCtx as never);

			const logged = loopBlocks();
			expect(logged).toHaveLength(2);
			expect(logged[0].durationMs).toBe(15000);
			expect((logged[0].metadata as Record<string, unknown>).worstSoFar).toBe(
				true,
			);
			expect(logged[1].durationMs).toBe(5000);
			// Not a new session worst, but still recorded.
			expect((logged[1].metadata as Record<string, unknown>).worstSoFar).toBe(
				false,
			);
		});

		// #1723 residual: the motivating case is a SYNCHRONOUS block, so the phase
		// actually burning the CPU is still running (and so unlogged) when the
		// probe samples. `recentPhases`/`lastPhase` name only the PREVIOUS
		// finished phase — this pins that when a phase is currently in flight, the
		// loop_block record names IT, with an elapsed time at least the block's
		// own duration.
		it("(d) #1723: an in-flight phase is named in the loop_block record, not just the previous finished one", async () => {
			const startedAt = new Date(Date.now() - 18_270).toISOString();
			phaseForWindowToReturn = {
				phase: "full_scan_18s",
				startedAt,
				stillRunning: true,
				elapsedMs: 18270,
			};
			statsToReturn = {
				maxMs: 18270,
				p99Ms: 0,
				meanMs: 0,
				windowWallMs: 32832,
				windowCpuMs: 21844,
				suspectSystemStall: false,
			};

			await fireTurnEnd();

			const logged = loopBlocks();
			expect(logged).toHaveLength(1);
			const metadata = logged[0].metadata as Record<string, unknown>;
			// The previous-finished-phase attribution is untouched (still reported).
			expect(metadata.lastPhase).toBe("graph_build");
			// The NEW attribution: what is still running right now.
			expect(metadata.inFlightPhase).toBe("full_scan_18s");
			expect(metadata.inFlightPhaseStartedAt).toBe(startedAt);
			expect(metadata.inFlightPhaseElapsedMs as number).toBeGreaterThanOrEqual(
				18270,
			);
		});

		it("(e) #1723: no in-flight phase means the new fields stay undefined instead of a false attribution", async () => {
			phaseForWindowToReturn = undefined;
			statsToReturn = {
				maxMs: 5000,
				p99Ms: 0,
				meanMs: 0,
				windowWallMs: 6000,
				windowCpuMs: 5500,
				suspectSystemStall: false,
			};

			await fireTurnEnd();

			const logged = loopBlocks();
			expect(logged).toHaveLength(1);
			const metadata = logged[0].metadata as Record<string, unknown>;
			expect(metadata.inFlightPhase).toBeUndefined();
			expect(metadata.inFlightPhaseElapsedMs).toBeUndefined();
		});

		// #1980: the stall class and its CPU-coverage ratio have to reach the
		// PERSISTED record, or the split exists only in memory and a reader
		// mining latency.log is back to computing the ratio by hand over 1221
		// records. The monitor owns the verdict; this pins that turn_end stamps
		// what the monitor decided instead of dropping it or re-deriving it.
		it("(g) #1980: the loop_block record carries the stall class and CPU coverage ratio", async () => {
			statsToReturn = {
				// #1980's own top row: d=19780ms cpu=7907ms wall=41295ms.
				maxMs: 19780,
				p99Ms: 0,
				meanMs: 0,
				windowWallMs: 41295,
				windowCpuMs: 7907,
				suspectSystemStall: false,
				stallClass: "non-cpu-stall",
				cpuCoverageRatio: 0.4,
			};

			await fireTurnEnd();

			const logged = loopBlocks();
			expect(logged).toHaveLength(1);
			const metadata = logged[0].metadata as Record<string, unknown>;
			// Pre-fix both fields are absent from the record entirely.
			expect(metadata.stallClass).toBe("non-cpu-stall");
			expect(metadata.cpuCoverageRatio).toBe(0.4);
			// The #1122 flag is untouched beside them, not replaced.
			expect(metadata.suspectSystemStall).toBe(false);
			expect(metadata.windowCpuMs).toBe(7907);
		});

		// #1723 review round 7, S3: `resetCurrentPhaseForSession()`'s call site
		// (index.ts's `session_start` handler, behind the #473 gate) is exactly
		// the kind of wiring `SESSION_STATE_REGISTRY`'s reachability derivation
		// cannot see (it walks `handleSessionStart`'s body specifically, and this
		// call sits BEFORE that function runs — see
		// `tests/support/session-state-registry.ts`'s exemption note). The
		// reviewer confirmed that reasoning is correct, but pointed out the
		// coverage gap it leaves: deleting the call site is invisible to every
		// existing test (113 stayed green). This test drives the REAL
		// `session_start` handler (not a direct call to
		// `resetCurrentPhaseForSession`) to close that gap at the one seam that
		// can see it.
		it("(f) #1723 S3: session_start clears a leaked in-flight phase via the real handler", async () => {
			const { default: registerExtension } = await import("../index.js");
			const mock = createPiMock();
			registerExtension(mock.asExtensionAPI() as never);

			// Seed a live bracket BEFORE firing session_start — simulates a phase
			// abandoned by a torn-down activation, per resetCurrentPhaseForSession's
			// own doc comment.
			phaseStarted("leaked_before_session_start");
			expect(getCurrentPhase()).toBeDefined();

			expect(mock.getHandlers("session_start")[0]).toBeTypeOf("function");
			const sessionCtx = {
				cwd: process.cwd(),
				ui: {
					notify: vi.fn(),
					setStatus: () => {},
					theme: { fg: (_c: string, s: string) => s },
				},
			};
			// `emit` runs the real handler and records the session for the teardown.
			await mock.emit("session_start", { reason: "new" }, sessionCtx);

			expect(getCurrentPhase()).toBeUndefined();
		});
	},
);
