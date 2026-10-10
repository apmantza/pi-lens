/**
 * #1618 review round 1 (blocker): the sweep hold shipped in the original PR
 * had ZERO tests referencing its API — mutating `isWorkspaceSweepActive` to
 * `return false` left the full suite green. These six probes exercise the
 * hold mechanism directly (not just through a mocked `runWorkspaceDiagnostics`
 * result, which never touches the real gate) so a regression in the gate
 * itself cannot ship silently again.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { CacheManager } from "../../../clients/cache-manager.js";
import { RuntimeCoordinator } from "../../../clients/runtime-coordinator.js";
import {
	cancelLSPIdleReset,
	getEffectiveLspIdleResetMs,
	handleTurnEnd,
} from "../../../clients/runtime-turn.js";
import {
	acquireWorkspaceSweepHold,
	getFullScanWallClockMs,
	getWorkspaceSweepMaxHoldAgeMs,
	isWorkspaceSweepActive,
	runWhenWorkspaceSweepIdle,
	SWEEP_IDLE_SAFETY_MARGIN_MS,
	_resetWorkspaceSweepHoldForTests,
} from "../../../clients/lsp/workspace-sweep-hold.js";
import { resetLSPService } from "../../../clients/lsp/capabilities.js";
import { _resetSubagentModeForTests } from "../../../clients/subagent-mode.js";
import { setupTestEnvironment } from "../test-utils.js";

const logLatencyMock = vi.fn();

vi.mock("../../../clients/latency-logger.js", async (importActual) => ({
	...(await importActual<
		typeof import("../../../clients/latency-logger.js")
	>()),
	logLatency: (entry: unknown) => logLatencyMock(entry),
}));

function loggedPhase(mock: ReturnType<typeof vi.fn>, phase: string): boolean {
	return mock.mock.calls.some(
		(call: unknown[]) => (call[0] as { phase?: string })?.phase === phase,
	);
}

const EMPTY_KNIP_RESULT = {
	success: true,
	issues: [],
	unusedExports: [],
	unusedFiles: [],
	unusedDeps: [],
	unlistedDeps: [],
	summary: "skipped",
};

function makeTurnEndDeps(
	runtime: RuntimeCoordinator,
	cacheManager: CacheManager,
	overrides: Record<string, unknown> = {},
) {
	return {
		ctxCwd: undefined,
		getFlag: () => false,
		dbg: () => {},
		runtime,
		cacheManager,
		knipClient: {
			ensureAvailable: async () => false,
			analyze: async () => EMPTY_KNIP_RESULT,
		},
		deadCodeClients: [],
		depChecker: { ensureAvailable: async () => false },
		testRunnerClient: { getTestRunTarget: () => null },
		resetLSPService: () => {},
		resetFormatService: () => {},
		...overrides,
	} as any;
}

describe("workspace sweep hold (#1618 review round 1)", () => {
	beforeEach(() => {
		_resetWorkspaceSweepHoldForTests();
	});
	afterEach(() => {
		_resetWorkspaceSweepHoldForTests();
		cancelLSPIdleReset();
	});

	it("1. defers idle reset while a sweep is held, then re-arms a FRESH delay once released", async () => {
		const env = setupTestEnvironment("pi-lens-sweep-hold-defer-");
		const runtime = new RuntimeCoordinator();
		const cacheManager = new CacheManager(false);
		const resetLSPService = vi.fn();

		vi.useFakeTimers();
		try {
			await handleTurnEnd(
				makeTurnEndDeps(runtime, cacheManager, {
					ctxCwd: env.tmpDir,
					resetLSPService,
				}),
			);
			const delayMs = getEffectiveLspIdleResetMs();

			// Hold acquired before the timer's original delay elapses.
			const release = acquireWorkspaceSweepHold();
			expect(isWorkspaceSweepActive()).toBe(true);

			// The timer fires INTO the hold — must defer, not destroy.
			await vi.advanceTimersByTimeAsync(delayMs);
			expect(resetLSPService).not.toHaveBeenCalled();

			// Stays deferred for as long as the hold is up, however long that is.
			await vi.advanceTimersByTimeAsync(delayMs * 2);
			expect(resetLSPService).not.toHaveBeenCalled();

			// Release — must re-arm a FRESH delay from NOW, not fire immediately
			// (which would mean it resumed a countdown that already elapsed).
			release();
			await vi.advanceTimersByTimeAsync(delayMs - 1);
			expect(resetLSPService).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(1);
			expect(resetLSPService).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
			env.cleanup();
		}
	});

	it("2. overlapping holds — the inner release must not open the gate", () => {
		const releaseOuter = acquireWorkspaceSweepHold();
		const releaseInner = acquireWorkspaceSweepHold();
		expect(isWorkspaceSweepActive()).toBe(true);

		releaseInner();
		// The outer hold is still up — the gate must stay closed.
		expect(isWorkspaceSweepActive()).toBe(true);

		releaseOuter();
		expect(isWorkspaceSweepActive()).toBe(false);
	});

	it("2b. a second module evaluation sees the first evaluation's hold", async () => {
		const first = await import("../../../clients/lsp/workspace-sweep-hold.js");
		vi.resetModules();
		const second = await import("../../../clients/lsp/workspace-sweep-hold.js");
		const release = first.acquireWorkspaceSweepHold();

		expect(second).not.toBe(first);
		expect(second.isWorkspaceSweepActive()).toBe(true);

		release();
		expect(second.isWorkspaceSweepActive()).toBe(false);
	});

	it("3. releasing the same hold twice is a no-op — it never affects a later, unrelated hold", () => {
		const release = acquireWorkspaceSweepHold();
		release();
		expect(isWorkspaceSweepActive()).toBe(false);

		// Second call: must not throw, and must not do anything destructive.
		expect(() => release()).not.toThrow();
		expect(isWorkspaceSweepActive()).toBe(false);

		// A fresh, unrelated hold acquired afterward must behave normally —
		// a double-release must never leave the gate's internal bookkeeping in
		// a state where a later real hold is invisible.
		const releaseLater = acquireWorkspaceSweepHold();
		expect(isWorkspaceSweepActive()).toBe(true);
		releaseLater();
		expect(isWorkspaceSweepActive()).toBe(false);
	});

	it("4. cancelLSPIdleReset during a deferred rearm must not resurrect idle reset", async () => {
		const env = setupTestEnvironment("pi-lens-sweep-hold-cancel-");
		const runtime = new RuntimeCoordinator();
		const cacheManager = new CacheManager(false);
		const resetLSPService = vi.fn();

		vi.useFakeTimers();
		try {
			await handleTurnEnd(
				makeTurnEndDeps(runtime, cacheManager, {
					ctxCwd: env.tmpDir,
					resetLSPService,
				}),
			);
			const delayMs = getEffectiveLspIdleResetMs();

			const release = acquireWorkspaceSweepHold();
			// Fires into the hold — defers and queues a rearm for when the hold
			// releases.
			await vi.advanceTimersByTimeAsync(delayMs);
			expect(resetLSPService).not.toHaveBeenCalled();

			// Explicit cancel WHILE still deferred (e.g. the session is closing).
			cancelLSPIdleReset();

			// Now the hold releases — the queued rearm must have been cancelled
			// too, not just the (already-null) direct timer handle.
			release();
			await vi.advanceTimersByTimeAsync(delayMs * 5);
			expect(resetLSPService).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
			env.cleanup();
		}
	});

	it("5. a second handleTurnEnd (active editing) while a rearm is pending must not resurrect after cancel", async () => {
		const env = setupTestEnvironment("pi-lens-sweep-hold-second-turn-");
		const runtime = new RuntimeCoordinator();
		const cacheManager = new CacheManager(false);
		const resetLSPService = vi.fn();

		vi.useFakeTimers();
		try {
			await handleTurnEnd(
				makeTurnEndDeps(runtime, cacheManager, {
					ctxCwd: env.tmpDir,
					resetLSPService,
				}),
			);
			const delayMs = getEffectiveLspIdleResetMs();

			const release = acquireWorkspaceSweepHold();
			// Fires into the hold — the direct timer handle is now null, but a
			// rearm is queued behind the hold.
			await vi.advanceTimersByTimeAsync(delayMs);
			expect(resetLSPService).not.toHaveBeenCalled();

			// The agent is back to actively editing: a SECOND handleTurnEnd call
			// with a modified file. `lspIdleResetTimeout` is null at this point
			// (the timer already fired into the defer), so a guard that only
			// checks that variable would wrongly conclude "nothing to cancel".
			cacheManager.writeTurnState(
				{
					files: {
						"/edited.ts": {
							modifiedRanges: [],
							importsChanged: false,
							lastEdit: new Date().toISOString(),
						},
					},
					turnCycles: 0,
					maxCycles: 3,
					lastUpdated: new Date().toISOString(),
				},
				env.tmpDir,
			);
			await handleTurnEnd(
				makeTurnEndDeps(runtime, cacheManager, {
					ctxCwd: env.tmpDir,
					resetLSPService,
				}),
			);

			// The hold finally releases — the rearm from the FIRST turn must have
			// been cancelled by the second (active-editing) turn, not fired.
			release();
			await vi.advanceTimersByTimeAsync(delayMs * 5);
			expect(resetLSPService).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
			env.cleanup();
		}
	});

	it("6. an env override to either constant can never push the derived delay below the sweep's own ceiling", () => {
		const savedFull = process.env.PI_LENS_LENS_DIAGNOSTICS_FULL_TIMEOUT_MS;
		const savedBudget = process.env.PI_LENS_LSP_BUDGET_IDLE_TIMEOUT_MS;
		process.env.PI_SUBAGENT_CHILD = "1";
		_resetSubagentModeForTests();
		try {
			const overrides: Array<[string | undefined, string | undefined]> = [
				[undefined, undefined],
				["1", "1"], // both tiny
				["1", "999999"], // budget override far ABOVE the (tiny) ceiling
				["999999", "1"], // ceiling far above a tiny budget override
				[undefined, "1"],
				["5000", undefined],
			];
			for (const [fullMs, budgetMs] of overrides) {
				if (fullMs === undefined)
					delete process.env.PI_LENS_LENS_DIAGNOSTICS_FULL_TIMEOUT_MS;
				else process.env.PI_LENS_LENS_DIAGNOSTICS_FULL_TIMEOUT_MS = fullMs;
				if (budgetMs === undefined)
					delete process.env.PI_LENS_LSP_BUDGET_IDLE_TIMEOUT_MS;
				else process.env.PI_LENS_LSP_BUDGET_IDLE_TIMEOUT_MS = budgetMs;

				const floor = getFullScanWallClockMs() + SWEEP_IDLE_SAFETY_MARGIN_MS;
				const effective = getEffectiveLspIdleResetMs();
				expect(effective).toBeGreaterThanOrEqual(floor);
			}
		} finally {
			if (savedFull === undefined)
				delete process.env.PI_LENS_LENS_DIAGNOSTICS_FULL_TIMEOUT_MS;
			else process.env.PI_LENS_LENS_DIAGNOSTICS_FULL_TIMEOUT_MS = savedFull;
			if (savedBudget === undefined)
				delete process.env.PI_LENS_LSP_BUDGET_IDLE_TIMEOUT_MS;
			else process.env.PI_LENS_LSP_BUDGET_IDLE_TIMEOUT_MS = savedBudget;
			delete process.env.PI_SUBAGENT_CHILD;
			_resetSubagentModeForTests();
		}
	});
});

// #1618 review round 3: a leaked hold permanently disables idle reset — the
// repo's own screen ("state that must re-arm at session_start cannot hide
// behind a process-lifetime latch") applied to this PR's OWN new state.
describe("workspace sweep hold — leaked-hold failsafes (#1618 review round 3)", () => {
	beforeEach(() => {
		_resetWorkspaceSweepHoldForTests();
		logLatencyMock.mockClear();
	});
	afterEach(() => {
		_resetWorkspaceSweepHoldForTests();
	});

	it("7. resetLSPService({reason: 'session_start'}) clears a held lock from a prior generation", () => {
		const release = acquireWorkspaceSweepHold();
		expect(isWorkspaceSweepActive()).toBe(true);

		let waiterFired = false;
		runWhenWorkspaceSweepIdle(() => {
			waiterFired = true;
		});
		expect(waiterFired).toBe(false);

		resetLSPService({ reason: "session_start" });

		expect(isWorkspaceSweepActive()).toBe(false);
		expect(waiterFired).toBe(true);
		expect(
			loggedPhase(logLatencyMock, "lsp_workspace_sweep_hold_session_reset"),
		).toBe(true);

		// The hold's own later release (the sweep that originally acquired it
		// eventually finishes) must be a safe no-op — never re-lock the gate or
		// double-fire the waiter.
		expect(() => release()).not.toThrow();
		expect(isWorkspaceSweepActive()).toBe(false);
	});

	it("7b. session_start with no held lock stays silent (no log record)", () => {
		expect(isWorkspaceSweepActive()).toBe(false);
		resetLSPService({ reason: "session_start" });
		expect(
			loggedPhase(logLatencyMock, "lsp_workspace_sweep_hold_session_reset"),
		).toBe(false);
	});

	it("8. a hold held past its max age force-releases with a distinct log record", () => {
		vi.useFakeTimers();
		try {
			acquireWorkspaceSweepHold();
			expect(isWorkspaceSweepActive()).toBe(true);

			const maxAgeMs = getWorkspaceSweepMaxHoldAgeMs();
			// Still within budget — must stay held (a real sweep can legitimately
			// run this long).
			vi.setSystemTime(new Date(Date.now() + maxAgeMs));
			expect(isWorkspaceSweepActive()).toBe(true);

			// Past the failsafe ceiling — can only be a leaked hold now.
			vi.setSystemTime(new Date(Date.now() + 1));
			expect(isWorkspaceSweepActive()).toBe(false);
			expect(
				loggedPhase(logLatencyMock, "lsp_workspace_sweep_hold_force_released"),
			).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});
});
