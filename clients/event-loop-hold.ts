/**
 * #2507: hold the event loop for the lifetime of in-flight work that would
 * otherwise be kept alive by NOTHING.
 *
 * Every handle pi-lens owns on the way to an LSP answer is deliberately
 * unref'd. `clients/lsp/launch.ts#unrefLspProcessHandles` unrefs the language
 * server child AND its three stdio pipes so a settled one-shot `pi --print`
 * can exit without waiting for a lingering server (the #1097/#1110 class);
 * `clients/child-unref.ts` does the same for every fire-and-forget probe
 * spawn; `bounded()` and several LSP waits unref their timers for the same
 * reason. That is correct for an IDLE process and wrong for a BUSY one: in a
 * headless child (`pi --mode json -p --no-extensions`, stdin ignored, no TUI,
 * no other extension holding a socket or timer) an in-flight `lsp_diagnostics`
 * call reaches a point where the only thing it is waiting on is an unref'd
 * timer or an unref'd pipe, libuv finds no referenced handle, and Node exits 0
 * IN THE MIDDLE of the tool call — no error, no result, no `turn_end`. The
 * reporter measured it against pyright; the drain site the repro lands on is
 * `LSPService.ensureWarmForSweep`'s warm-up retry backoff (an explicitly
 * `.unref()`'d `setTimeout`), but it is one of many: any await whose only
 * pending handle is unref'd has the same shape.
 *
 * The fix is NOT to stop unref'ing — that would leak a lingering server into
 * every settled one-shot process, which is the reason the unref exists. It is
 * to hold ONE referenced handle for exactly as long as something is in
 * flight: a counted keep-alive, armed while at least one hold is taken and
 * disarmed the moment the last one is released. Idle behaviour is therefore
 * byte-identical to before — no hold, no timer, nothing referenced.
 *
 * Shape 15's screen (AGENTS.md), which this follows deliberately:
 *  - a COUNTER of tokens, not a boolean, so overlapping tool calls each
 *    release independently and a throwing/aborted caller still releases
 *    (callers release from `finally`);
 *  - a bounded lifetime PER HOLD, because a leaked hold is the INVERSE defect
 *    (a process that can never exit). Each token gets {@link
 *    getEventLoopHoldMaxMs} measured from its OWN acquire — derived from the
 *    longest legitimate operation's ceiling (`getWorkspaceSweepMaxHoldAgeMs`,
 *    the full-scan wall clock plus its safety margin) rather than a second,
 *    independently-drifting literal. The keep-alive is armed for the SOONEST
 *    outstanding deadline; when it fires, only tokens that are actually stale
 *    are released (with a log record naming them), and it re-arms for
 *    whatever remains. An epoch-anchored version of this — one timer from the
 *    first hold, clearing every token when it fired — was #2649 review F1: a
 *    call issued late in a legitimate 300s `lens_diagnostics mode=full` was
 *    force-released seconds after starting, i.e. #2507's drain reproduced BY
 *    the fix.
 *
 * There is deliberately NO session-boundary clear here, unlike
 * `clients/lsp/workspace-sweep-hold.ts`. A `session_start` can land mid-turn
 * (see `clients/bootstrap.ts`), so clearing holds on a session boundary would
 * un-hold a tool call that is still running and reintroduce this exact defect
 * for it. The hold is scoped to one call's try/finally, not to a session.
 */

import {
	claimPhaseOncePerSession,
	logLatency,
	releaseOncePerSessionPhase,
} from "./latency-logger.js";
import { getWorkspaceSweepMaxHoldAgeMs } from "./lsp/workspace-sweep-hold.js";
import { getProcessSingleton } from "./process-singletons.js";

interface EventLoopHoldEntry {
	acquiredAt: number;
	label: string;
}

interface EventLoopHoldState {
	holds: Map<number, EventLoopHoldEntry>;
	nextHoldId: number;
	/** The ONE referenced handle. `undefined` whenever nothing is held. */
	timer: ReturnType<typeof setTimeout> | undefined;
}

/** The one row per session proving the keep-alive was taken (#2649 F2). */
const EVENT_LOOP_HOLD_ARMED_PHASE = "event_loop_hold_armed";

const EVENT_LOOP_HOLD_FAMILY = "event-loop-hold";
const EVENT_LOOP_HOLD_VERSION = 1;

/**
 * Process-scoped on purpose: pi evaluates the pi-lens module graph more than
 * once in one process (see `clients/process-singletons.ts`), and what is being
 * counted here is a property of the PROCESS's event loop, not of one module
 * evaluation. Two copies would arm two timers for one loop.
 */
function state(): EventLoopHoldState {
	return getProcessSingleton(
		EVENT_LOOP_HOLD_FAMILY,
		EVENT_LOOP_HOLD_VERSION,
		() => ({ holds: new Map(), nextHoldId: 1, timer: undefined }),
	);
}

/**
 * Upper bound on how long ONE hold — each hold, measured from its OWN
 * acquire — may keep this process alive. Derived from `lens_diagnostics
 * mode=full`'s own wall-clock ceiling plus the shared
 * `SWEEP_IDLE_SAFETY_MARGIN_MS` — the same derivation the workspace-sweep
 * hold's max-hold-age failsafe uses, so the two cannot drift apart into a
 * relationship where the longest legitimate tool call outlives the bound that
 * is supposed to only catch bugs.
 */
export function getEventLoopHoldMaxMs(): number {
	return getWorkspaceSweepMaxHoldAgeMs();
}

/**
 * Arm the keep-alive for the SOONEST deadline any outstanding hold has — the
 * earliest moment a token can become stale — never for a fixed epoch from the
 * first hold (#2649 review F1).
 *
 * Round 1 armed once on 0→1 and cleared every token when it fired, so a call
 * that started while an older one was still running inherited whatever was
 * left of the FIRST call's bound: a `lens_diagnostics mode=full` legitimately
 * running to its 300s ceiling force-released a healthy `lsp_diagnostics`
 * issued at t=305s, which is #2507's own drain produced by the fix. The
 * reviewer reproduced it in a real child with the bound shortened: both calls
 * unsettled, `active=[]`, `EXIT code=0`.
 *
 * Soonest-deadline, not the youngest survivor's: the youngest would let an
 * older survivor overstay its own max age by the whole age gap. Each token is
 * released when IT is stale and never before.
 */
function armForNextDeadline(current: EventLoopHoldState): void {
	if (current.timer !== undefined) return;
	if (current.holds.size === 0) return;
	const maxMs = getEventLoopHoldMaxMs();
	let soonest = Number.POSITIVE_INFINITY;
	for (const entry of current.holds.values()) {
		soonest = Math.min(soonest, entry.acquiredAt + maxMs);
	}
	// A past-due deadline is left negative on purpose: Node clamps any delay
	// below 1ms to 1ms, so it fires on a later turn of the loop either way, and
	// a hand-written floor here would be a guard naming a recurrence that
	// cannot happen (#2649 verify F4 — probed: 5 re-arms at delay -5000
	// completed in 5ms, and no test reds without the floor).
	const delayMs = soonest - Date.now();
	// NOT `unref()`'d — referencing the loop is this timer's entire job. It is
	// also the failsafe: when it fires, whatever is stale is over either way.
	current.timer = setTimeout(() => reapStaleHolds(), delayMs);
}

function disarmIfIdle(current: EventLoopHoldState): void {
	if (current.holds.size > 0) return;
	if (current.timer === undefined) return;
	clearTimeout(current.timer);
	current.timer = undefined;
}

/**
 * Release every hold that has outlived {@link getEventLoopHoldMaxMs} ON ITS
 * OWN CLOCK, log what was released, and re-arm for whatever is still
 * outstanding. Same shape as `clients/lsp/workspace-sweep-hold.ts`'s
 * `reapStaleHolds` — deliberately a second, independent implementation rather
 * than a shared ledger (that consolidation is tracked separately).
 */
function reapStaleHolds(): void {
	const current = state();
	current.timer = undefined;
	try {
		const maxMs = getEventLoopHoldMaxMs();
		const now = Date.now();
		const released: EventLoopHoldEntry[] = [];
		for (const [holdId, entry] of current.holds) {
			if (now - entry.acquiredAt <= maxMs) continue;
			current.holds.delete(holdId);
			released.push(entry);
		}
		if (released.length > 0) {
			recordForceReleased(released, current.holds.size, maxMs, now);
		}
	} finally {
		// A survivor is held by nothing until this re-arms — the drain — and
		// forever if it never does — the leak. In a `finally` because this runs
		// inside a timer callback, where anything that escapes is an uncaught
		// exception, and because the round-2 code put the log between the reap
		// and the re-arm: a throwing sink stranded the survivor (#2649 verify
		// F3). The map is already consistent by here — entries are deleted
		// before anything is logged.
		armForNextDeadline(current);
	}
}

/**
 * The force-release record, and its own absorption. Telemetry may not break
 * the guard it observes — the house rule spelled at
 * `clients/runtime-tool-call.ts`'s blocked-attribution cleanup: a guard that
 * fails because its telemetry broke is worse than no guard. Nothing here has
 * a fallback sink to escalate to; the keep-alive's correctness does not
 * depend on the row being written.
 */
function recordForceReleased(
	released: readonly EventLoopHoldEntry[],
	stillHeld: number,
	maxMs: number,
	now: number,
): void {
	try {
		const oldestAcquiredAt = Math.min(
			...released.map((entry) => entry.acquiredAt),
		);
		logLatency({
			type: "phase",
			phase: "event_loop_hold_force_released",
			filePath: "",
			durationMs: now - oldestAcquiredAt,
			metadata: {
				maxHoldMs: maxMs,
				releasedHolds: released.length,
				stillHeld,
				labels: [...new Set(released.map((entry) => entry.label))].slice(0, 8),
			},
		});
	} catch {
		// see the doc comment — a broken sink must not reach the reap path
	}
}

/**
 * ONE row per session saying the keep-alive was actually taken (#2649 review
 * F2). Without it the only record this module ever writes is the failsafe, so
 * a silent log cannot distinguish "working as designed" from "never wired at
 * all" — the #2526 gap shape. Claimed through the logger's own
 * once-per-session mechanism rather than a private latch, so the "one row per
 * session" a reader counts against is the same property `config_resolved`
 * has.
 */
function recordFirstArm(entry: EventLoopHoldEntry, maxMs: number): void {
	try {
		if (!claimPhaseOncePerSession(EVENT_LOOP_HOLD_ARMED_PHASE, "process")) {
			return;
		}
		logLatency({
			type: "phase",
			phase: EVENT_LOOP_HOLD_ARMED_PHASE,
			filePath: "",
			durationMs: 0,
			metadata: { label: entry.label, maxHoldMs: maxMs },
		});
	} catch {
		// This runs on the ACQUIRE path, and `normalizeToolDefinition` takes the
		// hold outside its own try — so a throw here rejected the tool call with
		// the sink's error instead of returning the tool's result (#2649 verify
		// F3). Same house rule as `recordForceReleased` above: the hold is
		// already taken and armed by this point, so absorbing the throw loses a
		// log row and nothing else.
	}
}

/**
 * Take one hold for the lifetime of a piece of in-flight work, and return its
 * release. Callers MUST release from a `finally` block: a throw, a rejection
 * or an abort has to release exactly like a normal return, or the hold leaks
 * and the process stops being able to exit.
 *
 * The release is identity-guarded and idempotent — calling it twice, or after
 * the max-age failsafe already force-released it, is a no-op and never
 * disarms another caller's hold.
 */
export function acquireEventLoopHold(label: string): () => void {
	const current = state();
	const holdId = current.nextHoldId++;
	const entry: EventLoopHoldEntry = { acquiredAt: Date.now(), label };
	current.holds.set(holdId, entry);
	const wasArmed = current.timer !== undefined;
	armForNextDeadline(current);
	if (!wasArmed) recordFirstArm(entry, getEventLoopHoldMaxMs());
	return () => {
		const now = state();
		if (!now.holds.delete(holdId)) return;
		disarmIfIdle(now);
	};
}

/** Test-only: how many holds are outstanding right now. */
export function _eventLoopHoldCountForTests(): number {
	return state().holds.size;
}

/**
 * Test-only: the keep-alive handle's own state. `hasRef` is the property the
 * whole fix rests on — a handle that is armed but unref'd holds nothing — so
 * it is read from the live `Timeout` (`hasRef()`), not asserted from the
 * source text.
 */
export function _eventLoopKeepAliveForTests(): {
	armed: boolean;
	hasRef: boolean;
} {
	const timer = state().timer as
		| (ReturnType<typeof setTimeout> & { hasRef?: () => boolean })
		| undefined;
	return {
		armed: timer !== undefined,
		hasRef: timer?.hasRef?.() === true,
	};
}

/** Test-only: drop every hold and disarm, between tests. */
export function _resetEventLoopHoldForTests(): void {
	// This module's own phase only — never a blanket clear of a structure other
	// producers claim in (`releaseOncePerSessionPhase`'s doc comment).
	releaseOncePerSessionPhase(EVENT_LOOP_HOLD_ARMED_PHASE);
	const current = state();
	current.holds.clear();
	if (current.timer !== undefined) clearTimeout(current.timer);
	current.timer = undefined;
	current.nextHoldId = 1;
}
