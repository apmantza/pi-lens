/**
 * #1618: a full workspace sweep (`LSPService.runWorkspaceDiagnostics`, the
 * engine behind `lens_diagnostics mode=full`) grants itself a wall-clock
 * ceiling (`FULL_SCAN_WALL_CLOCK_MS`, see {@link getFullScanWallClockMs})
 * that can outlive the detached LSP idle-reset timer armed by
 * `clients/runtime-turn.ts`'s `handleTurnEnd` on a file-less turn. Nothing
 * previously stopped that timer from firing mid-sweep and destroying the
 * very service the sweep was actively touching — every file the sweep had
 * not yet reached then failed with zero trace and got mislabeled as budget
 * exhaustion.
 *
 * This module is the shared hold: `runWorkspaceDiagnostics` acquires it for
 * its own lifetime (try/finally, so a throw or an aborted sweep still
 * releases it) and the idle-reset timer consults it before firing. Holds are
 * tracked as TOKENS (acquire-time-stamped), not a bare counter — two
 * overlapping `lens_diagnostics mode=full` calls (or a sweep started while
 * another is still finishing) must each be free to release independently
 * without the other's hold being dropped early.
 *
 * A leaked hold that never re-arms idle reset is the inverse defect (state
 * that must re-arm cannot hide behind a stuck guard), so this module screens
 * against it on TWO axes, matching the repo's own session-boundary +
 * bounded-lifetime conventions:
 *   1. `clearWorkspaceSweepHoldForSessionStart` — `resetLSPService({reason:
 *      "session_start"})` clears every held token unconditionally. A session
 *      boundary means no in-flight sweep from a PRIOR generation is still
 *      meaningful to wait on.
 *   2. `reapStaleHolds` (internal, called from every liveness check) —
 *      force-releases any token older than {@link getWorkspaceSweepMaxHoldAgeMs},
 *      derived from the sweep's own wall-clock ceiling plus a safety margin.
 *      A real sweep is either done or self-aborted well within that window
 *      (`tools/lens-diagnostics.ts` races `FULL_SCAN_WALL_CLOCK_MS`), so a
 *      token still held past it can only be a bug — never a legitimate long
 *      sweep — and gets force-released with its own distinct log record.
 *
 * `getFullScanWallClockMs` also lives here (rather than duplicated between
 * `tools/lens-diagnostics.ts` and `clients/runtime-turn.ts`) so the idle-reset
 * delay on every path (base AND the subagent/budget-shortened paths) can be
 * DERIVED from the sweep's own ceiling instead of the constants drifting
 * apart again (#1618 acceptance criterion 6).
 */

import { logLatency } from "../latency-logger.js";
import { getProcessSingleton } from "../process-singletons.js";

/** Extra headroom beyond the sweep's own wall-clock ceiling before an
 *  idle-reset delay (or the max-hold-age failsafe) trusts that a real sweep
 *  must be done. Single source for both derivations below AND for every
 *  idle-reset path `clients/runtime-turn.ts` derives (base, subagent, and
 *  budget-shortened) — never a second independently-tunable literal. */
export const SWEEP_IDLE_SAFETY_MARGIN_MS = 60_000;

interface WorkspaceSweepHoldState {
	holds: Map<number, number>;
	nextHoldId: number;
	idleWaiters: Array<() => void>;
}

const WORKSPACE_SWEEP_HOLD_FAMILY = "lsp.workspace-sweep-hold";
const WORKSPACE_SWEEP_HOLD_VERSION = 1;

function state(): WorkspaceSweepHoldState {
	return getProcessSingleton(
		WORKSPACE_SWEEP_HOLD_FAMILY,
		WORKSPACE_SWEEP_HOLD_VERSION,
		() => ({ holds: new Map(), nextHoldId: 1, idleWaiters: [] }),
	);
}

function flushIdleWaitersIfEmpty(): void {
	const current = state();
	if (current.holds.size > 0) return;
	if (current.idleWaiters.length === 0) return;
	const waiters = current.idleWaiters;
	current.idleWaiters = [];
	for (const waiter of waiters) {
		try {
			waiter();
		} catch {
			// Best-effort — a waiter failure must never propagate into the
			// releasing/reaping call stack.
		}
	}
}

/**
 * A held token past this age can only be a bug (leaked release, a sweep that
 * hung outside its own abort signal, …) — a legitimate sweep is done or
 * self-aborted well before it. Derived, not a separate literal, so it can't
 * drift out of sync with `getFullScanWallClockMs` the way the idle-reset
 * timer and the sweep's own ceiling once did.
 */
export function getWorkspaceSweepMaxHoldAgeMs(): number {
	return getFullScanWallClockMs() + SWEEP_IDLE_SAFETY_MARGIN_MS;
}

function reapStaleHolds(): void {
	const current = state();
	if (current.holds.size === 0) return;
	const maxAgeMs = getWorkspaceSweepMaxHoldAgeMs();
	const now = Date.now();
	for (const [holdId, acquiredAt] of current.holds) {
		const ageMs = now - acquiredAt;
		if (ageMs <= maxAgeMs) continue;
		current.holds.delete(holdId);
		logLatency({
			type: "phase",
			phase: "lsp_workspace_sweep_hold_force_released",
			filePath: "",
			// The hold's age at the reap, not work anyone did (#5379).
			ageMs,
			metadata: { holdId, maxHoldAgeMs: maxAgeMs },
		});
	}
	flushIdleWaitersIfEmpty();
}

/**
 * Acquire the hold for one `runWorkspaceDiagnostics` call. Returns a release
 * function; callers MUST call it from a `finally` block so an overlapping or
 * throwing sweep still releases its hold. Idempotent — calling the returned
 * function more than once past the first call, or after the hold was already
 * force-released (session reset / max-age reap), is a no-op.
 */
export function acquireWorkspaceSweepHold(): () => void {
	const current = state();
	const holdId = current.nextHoldId++;
	current.holds.set(holdId, Date.now());
	return () => {
		if (!state().holds.delete(holdId)) return;
		flushIdleWaitersIfEmpty();
	};
}

/** True while at least one `runWorkspaceDiagnostics` sweep is in flight.
 *  Reaps stale holds first, so a leaked/hung hold can't permanently read as
 *  "active" past its own max age. */
export function isWorkspaceSweepActive(): boolean {
	reapStaleHolds();
	return state().holds.size > 0;
}

/**
 * Run `cb` once the hold count next returns to zero. Runs synchronously and
 * immediately when no sweep is active right now — the common case, and the
 * one every non-sweep idle-reset arm/fire takes.
 */
export function runWhenWorkspaceSweepIdle(cb: () => void): void {
	reapStaleHolds();
	const current = state();
	if (current.holds.size === 0) {
		cb();
		return;
	}
	current.idleWaiters.push(cb);
}

/**
 * `resetLSPService({reason: "session_start"})` calls this: a session
 * boundary means no hold from a PRIOR generation is still meaningful to wait
 * on, so every held token is cleared unconditionally (state that must
 * re-arm at session_start cannot hide behind a leaked/stuck guard from the
 * generation before it). Only logs when there was actually something to
 * clear — the common case (no sweep in flight at session boundary) stays
 * silent.
 */
export function clearWorkspaceSweepHoldForSessionStart(): void {
	const current = state();
	if (current.holds.size === 0) return;
	logLatency({
		type: "phase",
		phase: "lsp_workspace_sweep_hold_session_reset",
		filePath: "",
		durationMs: 0,
		metadata: { clearedHolds: current.holds.size },
	});
	current.holds.clear();
	flushIdleWaitersIfEmpty();
}

/** Test-only: reset the process-singleton hold state between tests. */
export function _resetWorkspaceSweepHoldForTests(): void {
	const current = state();
	current.holds.clear();
	current.idleWaiters = [];
	current.nextHoldId = 1;
}

/**
 * Wall-clock ceiling for one `lens_diagnostics mode=full` scan
 * (`runWorkspaceDiagnostics` plus its concurrent project-runner/analyzer
 * work). Single source for `tools/lens-diagnostics.ts` (the sweep caller),
 * `clients/runtime-turn.ts` (every idle-reset path, whose delay must outlive
 * it), and this module's own max-hold-age failsafe — lazy env read, never
 * memoized, matching this codebase's house style so a test can flip the
 * override mid-run.
 */
export function getFullScanWallClockMs(): number {
	const raw = Number(process.env.PI_LENS_LENS_DIAGNOSTICS_FULL_TIMEOUT_MS);
	return Number.isFinite(raw) && raw > 0 ? raw : 300_000; // 5 min default
}
