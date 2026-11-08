/**
 * Cascade neighbour-budget sizing (#1462).
 *
 * The flat neighbour cap (40) and the turn-end settle wait (5000 ms) were set in
 * two different files with nothing relating them. Dogfood 2026-08-15 measured
 * what that costs: n=50 cascades, median 30 ms, max 3.88 s at nbr=40 — and with
 * a `reverse_deps_cache` refresh ahead of the graph build (2046 ms for
 * `logger.ts`) the run overran the turn_end cap, so `cascade_settle_wait`
 * returned `settled: 0` and the finding arrived a turn late.
 *
 * ## What a slow run actually costs
 *
 * It is NOT lost. `RuntimeCoordinator.settleCascadeRuns` re-parks a promise
 * still in flight at the cap, `agent_settled` gives it a second and more
 * generous drain (`cascade_carry_over_settle`, `quietWindowWaitMs`, 15 000 ms),
 * and `beginTurn` deliberately keeps `_pendingCascadeRuns` so anything still
 * running surfaces at a later turn_end — that is #1443, and pre-#450 these
 * findings were always awaited. So the real trade is:
 *
 *   full neighbour set, one turn late   vs.   a narrowed set, on time,
 *                                             with the remainder lost for good
 *
 * Narrowing is therefore only worth paying for when it genuinely converts a
 * late run into an on-time one. That gives three zones, and the derivation
 * below is exactly those three:
 *
 *   fits         the full walk still fits the on-time window — nothing to do
 *   narrowed     the RESCUE BAND: the full walk no longer fits but a shorter
 *                one does, so trading the tail for on-time delivery buys
 *                something real
 *   past-rescue  not even a floor-sized walk fits any more, so narrowing would
 *                drop neighbours permanently AND still miss the window. Keep
 *                the full budget and let the carry-over deliver it complete.
 *                This is the cold-session case: a fresh graph build measures up
 *                to ~19 s (see `runtime-coordinator.ts`'s carry-over note), and
 *                a floor-sized stub there is strictly worse than pre-#1462.
 *
 * One more guard, for the same reason. If the on-time window could not fit a
 * full walk even at zero prelude, there is no LATE run to rescue — every
 * cascade would be permanently downsized because a *wait* was configured small.
 * That is a budget change wearing a timeout's clothes, so the derivation stands
 * down entirely (`no-rescue-window`) and the flat cap applies. This is what
 * keeps `PI_LENS_CASCADE_SETTLE_WAIT_MS` from doubling as a neighbour-count
 * knob: at the 5000/100/40 defaults the band is a prelude of 1.0–4.5 s, and
 * shrinking the wait to 1000 ms disables narrowing rather than capping every
 * cascade at ~10 neighbours.
 */

import { recordDegradationOnce } from "./degradation-ledger.js";
import { nonNegativeIntEnv, toPositiveFinite } from "./env-utils.js";
// The knobs only, never the scheduler — this module is arithmetic and has no
// business depending on a task registry to read two numbers (#1462 review N4).
// Note it buys nothing at load time: `runtime-config.js` below already reaches
// `pidusage` via `lens-config.js`.
import {
	isQuietWindowEnabled,
	quietWindowWaitMs,
} from "./quiet-window-config.js";
import { RUNTIME_CONFIG } from "./runtime-config.js";

/**
 * Bounded wait for the turn's deferred cascade computes (#450) to settle before
 * they are merged at turn_end. A late compute is carried over, never dropped.
 *
 * `0` is a meaningful setting (never block turn_end), so this deliberately does
 * NOT use `lazyEnvNumber` — that helper treats 0 as "unset" and would silently
 * restore the 5000 ms default.
 */
export function cascadeSettleWaitMs(): number {
	return nonNegativeIntEnv("PI_LENS_CASCADE_SETTLE_WAIT_MS", 5000);
}

/** The budget floor, and the minimum any env override of the cap can produce. */
const MIN_NEIGHBOUR_BUDGET = RUNTIME_CONFIG.pipeline.cascadeMaxFiles;

/**
 * The flat per-run cap: the most neighbours a cascade walks. Still the ceiling
 * — the derivation below only ever narrows it, and only inside the rescue band.
 */
const DEFAULT_NEIGHBOUR_BUDGET = 40;

export const CASCADE_NEIGHBOUR_BUDGET = Math.max(
	MIN_NEIGHBOUR_BUDGET,
	Number.parseInt(process.env.PI_LENS_CASCADE_NEIGHBOUR_BUDGET ?? "40", 10) ||
		DEFAULT_NEIGHBOUR_BUDGET,
);

/**
 * True when `PI_LENS_CASCADE_NEIGHBOUR_BUDGET` moved the ceiling away from the
 * default (#1462 review F-E). Raising it far enough can push
 * `ceiling * perNeighbourMs` past the settle window, so EVERY cascade reads
 * `no-rescue-window` — the whole derivation disarmed by a cap change nobody
 * meant as a timeout change. Read once at load, same lifetime as the constant
 * it describes.
 */
const NEIGHBOUR_BUDGET_OVERRIDDEN =
	process.env.PI_LENS_CASCADE_NEIGHBOUR_BUDGET !== undefined &&
	CASCADE_NEIGHBOUR_BUDGET !== DEFAULT_NEIGHBOUR_BUDGET;

/**
 * Marginal wall-clock cost of one more neighbour in the walk, in ms. Calibrated
 * on the 2026-08-15 dogfood tail: 3.88 s at nbr=40 and 3.71 s at nbr=38, both
 * ~97 ms per neighbour. Touches fan out in parallel, so this is the observed
 * marginal cost under LSP contention, not one touch's own latency.
 *
 * It is an ESTIMATE, and the derivation is sensitive to it: if the true cost is
 * materially above this, a walk sized against it still overruns (the rescue
 * fails and the tail was dropped for nothing). `scripts/bench-cascade-budget.mjs
 * --true-cost-ms=<n>` measures that sensitivity directly. Rounded UP from the
 * measurement so the estimate errs toward narrowing less.
 */
const DEFAULT_NEIGHBOUR_COST_MS = 100;

/** Read per call — sized once per cascade run, never on a hot path. */
function neighbourCostMs(): number {
	return (
		toPositiveFinite(process.env.PI_LENS_CASCADE_NEIGHBOUR_COST_MS) ||
		DEFAULT_NEIGHBOUR_COST_MS
	);
}

function neighbourFloor(): number {
	return (
		toPositiveFinite(process.env.PI_LENS_CASCADE_NEIGHBOUR_FLOOR) ||
		MIN_NEIGHBOUR_BUDGET
	);
}

/** Which of the four rules decided this run's budget. */
export type CascadeBudgetZone =
	| "fits"
	| "narrowed"
	| "past-rescue"
	| "no-rescue-window";

export interface CascadeBudgetDecision {
	/** Neighbours this run may walk — the budget in force. */
	budget: number;
	/** The flat cap. `budget < ceiling` means the rescue band narrowed the walk. */
	ceiling: number;
	/** On-time window left when the walk was sized; negative means overspent. */
	remainingMs: number;
	/** Which rule decided it — the whole reason, in one field. */
	zone: CascadeBudgetZone;
	/**
	 * How long the delivery pipeline keeps a slow run alive before it needs a
	 * later turn_end: the turn_end settle plus the `agent_settled` quiet-window
	 * drain. RECORDED, not a divisor — it puts the second window on the record
	 * so a reader of `cascade_result` sees the whole deadline stack instead of
	 * just the 5000 ms one. It does NOT feed any zone: kill the quiet window and
	 * every budget this function returns is unchanged. What lets `past-rescue`
	 * keep the full budget is `beginTurn` never clearing `_pendingCascadeRuns`
	 * (`runtime-coordinator.ts`), which retains a slow compute until it resolves
	 * however long that takes; the drain only gets it there sooner.
	 *
	 * Counts the drain only when it will actually run: `PI_LENS_QUIET_WINDOW=0`
	 * disables the scheduler while `quietWindowWaitMs()` keeps returning its
	 * budget, so reading the budget alone would claim 15 s of drain that no
	 * longer exists (#1462 review N3).
	 */
	deliveryWindowMs: number;
}

/**
 * Size one run's neighbour walk against the on-time window supplied by its
 * caller.
 *
 * `elapsedMs` is arithmetic input, not an observation made by this function.
 * The production caller measures it against the active turn_end settle window
 * and passes that elapsed time here. When that boundary is unavailable, the
 * caller passes zero to preserve the flat cap. Legacy callers may still pass
 * deferred run age for compatibility.
 *
 * Every override exists so the derivation can be tested and benchmarked as a
 * pure function; the function itself does not observe a deferred run's age.
 */
export function deriveCascadeNeighbourBudget(options: {
	elapsedMs: number;
	settleWaitMs?: number;
	quietDrainMs?: number;
	ceiling?: number;
	floor?: number;
	perNeighbourMs?: number;
}): CascadeBudgetDecision {
	const ceiling = options.ceiling ?? CASCADE_NEIGHBOUR_BUDGET;
	// The floor can never exceed the ceiling — a floor above the cap would make
	// the derived budget LARGER than the flat one it exists to bound.
	const floor = Math.min(ceiling, options.floor ?? neighbourFloor());
	const onTimeMs = options.settleWaitMs ?? cascadeSettleWaitMs();
	const perNeighbourMs = options.perNeighbourMs ?? neighbourCostMs();
	const elapsedMs = toPositiveFinite(options.elapsedMs);
	const remainingMs = onTimeMs - elapsedMs;
	const deliveryWindowMs =
		onTimeMs +
		(options.quietDrainMs ??
			(isQuietWindowEnabled() ? quietWindowWaitMs() : 0));
	const full = { budget: ceiling, ceiling, remainingMs, deliveryWindowMs };

	// No on-time window at all, or one too small to ever fit a full walk. There
	// is no late run to rescue here, only every run to shrink — stand down.
	//
	// Boundary, acknowledged rather than special-cased: at exactly
	// `onTimeMs === ceiling * perNeighbourMs` this does not fire and the `fits`
	// zone has zero width, so ANY prelude narrows. Not slightly, either — at
	// 4000/100/40 a 2 s prelude gives 20 and a 3.5 s prelude gives the floor.
	// Left alone because the narrowing is honest at that setting: with the
	// window sized to exactly one full walk, a run that has spent any of it
	// really would miss, so every one of those cuts is a genuine rescue rather
	// than the `no-rescue-window` case this guard exists to catch. What it does
	// cost is headroom — see the divisor bands in the bench's `--sweep` text.
	if (onTimeMs <= 0 || onTimeMs < ceiling * perNeighbourMs) {
		// #1462 review F-E: name the override, once per session, when it is the
		// REASON the derivation stood down — not when a caller under test asked
		// for a specific ceiling, and not on every one of the cascades this
		// disarms for the rest of the session.
		if (options.ceiling === undefined && NEIGHBOUR_BUDGET_OVERRIDDEN) {
			recordDegradationOnce({
				kind: "cascade-budget-override-disarmed",
				subject: "cascade-neighbour-budget",
				reason:
					`PI_LENS_CASCADE_NEIGHBOUR_BUDGET=${CASCADE_NEIGHBOUR_BUDGET} needs ` +
					`${ceiling * perNeighbourMs}ms to walk the full cap, which exceeds ` +
					`the ${onTimeMs}ms settle window — the rescue band is disarmed and ` +
					`every cascade keeps the flat (overridden) cap`,
			});
		}
		return { ...full, zone: "no-rescue-window" };
	}
	// The full walk still fits. Nothing to buy.
	if (remainingMs >= ceiling * perNeighbourMs) {
		return { ...full, zone: "fits" };
	}
	// Past rescue: not even a floor-sized walk fits, so narrowing would drop the
	// tail permanently and still miss the window. The carry-over delivers the
	// whole set one turn later instead.
	//
	// #1462 review F-B, kept rather than shrunk: one dogfood log measured this
	// zone at 0/1090 cascades, and asked whether a 3-zone module earns its keep
	// at that frequency. It was measured against the WRITE-relative clock this
	// same round fixed, which charges elapsed time no cascade actually spent
	// waiting — so it under-counts how often a genuinely slow compute (a cold
	// graph build, ~19 s) overlaps an already-running settle window, which is
	// exactly what this zone exists to catch (F3, a real regression the first
	// review round found: a floor-sized stub on that cold-start case is
	// strictly worse than pre-#1462). Reachability under the corrected clock
	// has not been re-measured; shrinking on a stale sample would trade a
	// cheap, already-tested guard against a proven regression for a paper
	// simplification. Revisit if a post-fix dogfood window confirms it still
	// never fires.
	if (remainingMs < floor * perNeighbourMs) {
		return { ...full, zone: "past-rescue" };
	}
	// The rescue band: a shorter walk lands on time.
	return {
		budget: Math.min(
			ceiling,
			Math.max(floor, Math.floor(remainingMs / perNeighbourMs)),
		),
		ceiling,
		remainingMs,
		deliveryWindowMs,
		zone: "narrowed",
	};
}
