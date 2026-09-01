/**
 * Typed bounded telemetry emission (#1743).
 *
 * Four PRs in two days hand-built the same machinery: a failure path that
 * needs a detailed `latency.log` record, an exact per-identity tally, and a
 * bound so a storming subsystem cannot flood the log. #1705 (orphan
 * forensics), #1717 (pull timeouts and late answers), #1726 (navRequest
 * timeouts, rising edge per method and file), and #1733 (loop-block floor
 * with a per-turn bound) each rebuilt it, and each needed a review round to
 * get the bounding right. This module is the intersection of those four, not
 * a speculative framework. Three of its four options come straight from those
 * sites. The fourth, `capPerTurn`, expresses #1733's per-turn bound
 * structurally and now caps re-raised auxiliary coverage-gap detail rows
 * (#2356), while the aggregate count and ledger retain bounded latest
 * identities plus the dropped count.
 *
 * Three rules the helper makes structural instead of prose:
 *
 * 1. **The rising edge comes from the ledger's own tally.** #1705 established
 *    that `incrementDegradationCount` already knows whether a
 *    (kind, subject) pair is being seen for the first time, and returns it.
 *    A caller that wants "log the detail once, count the rest" reads that
 *    return value. It never keeps a second `Set` — a parallel latch is state
 *    that must re-arm at `session_start` and will eventually be forgotten
 *    (the #1266–#1625 defect class).
 * 2. **A per-turn cap names its turn.** `capPerTurn` carries the caller's
 *    `turnIndex` in the same object as the limit. A bounded 64-turn window
 *    keeps overlapping async turns independent; results older than that window
 *    fail closed. Session start clears the window when numbering restarts.
 * 3. **Identity always survives.** Every emitted record carries the
 *    discriminating identity in `filePath` and in `metadata.identity`, so
 *    aggregation can still answer "which file, which method, which record is
 *    stuck" (the rule AGENTS.md states, now enforced by the signature).
 *
 * `BOUNDED_TELEMETRY_PHASES` is the registry.
 * `tests/clients/bounded-telemetry-sweep.test.ts` sweeps it registered-or-
 * fail: a failure-path phase must either route through this helper or carry a
 * stated reason for staying raw.
 *
 * Nothing here ever throws. Telemetry must not perturb the path it observes —
 * each caller has already decided its outcome before
 * calling in.
 */

import type { DegradationKind } from "./degradation-ledger.js";
import { incrementDegradationCount } from "./degradation-ledger.js";
import { type LatencyEntry, logLatency } from "./latency-logger.js";

/**
 * Phases that emit through this helper. The `phase` parameter is typed to
 * this list, so a new bounded phase cannot be emitted without joining the
 * registry, and the sweep proves the reverse direction: a registered phase
 * must not also be written by a raw `logLatency` call somewhere else.
 */
export const BOUNDED_TELEMETRY_PHASES = [
	/** #1705: a deferred-format record whose origin worktree never claimed it. */
	"agent_end_deferred_format_orphan_origin_mismatch",
	/** #1713: a `textDocument`/`workspace` diagnostic pull abandoned at budget. */
	"lsp_pull_diagnostic_timeout",
	/** #1713: that abandoned pull answered anyway, too late to serve anyone. */
	"lsp_pull_late_answer_discarded",
	/** #1773: a pull skipped outright because the caller's budget was already
	 *  exhausted — never dispatched, so it must not be confused with a genuine
	 *  timeout. */
	"lsp_pull_skipped_budget_exhausted",
	/** #1774: an abandoned pull's request eventually REJECTED (e.g. a server
	 *  `ContentModified`) rather than answering or staying silent forever —
	 *  the third outcome late-answer telemetry previously could not see. */
	"lsp_pull_late_rejection",
	/** #1716: a hover/definition/references/etc. request abandoned at budget. */
	"lsp_nav_request_timeout",
	/** #1716: that abandoned nav request answered anyway, after the caller left. */
	"lsp_nav_late_answer_discarded",
	/**
	 * #1743 review: a per-file touch skipped a server in breaker cooldown or
	 * latched permanently broken. Fires once per file per touch during an
	 * outage, so it is rising-edge per (server, file).
	 */
	"lsp_client_skipped_broken",
	/** #1743 review: the same skip, for a temporarily unavailable command. */
	"lsp_client_skipped_unavailable_command",
	/**
	 * #1934: `getWarmClientForFile` found no live client for a file that has at
	 * least one language server with a resolvable root. Its callers run per
	 * file (the cascade quiet window, read expansion, `hasWarmLSP`), so it is
	 * rising-edge per candidate (server, root) set, with the ledger holding the
	 * exact count.
	 */
	"lsp_warm_client_missing",
	/** #2052: a file's nearest LSP root is outside the session ceiling. */
	"lsp_capability_skip",
	/**
	 * #2044: failed-first test state was retired after a confirmed missing path,
	 * retained because the filesystem verdict was indeterminate, or evicted at
	 * the state cap. Selection checks and detailed rows are both capped per turn.
	 */
	"test_runner_failed_target_state",
	/** #2366: bounded lifecycle records for automatic test-result delivery. */
	"test_runner_delivery",
	/**
	 * #1723: an event-loop block at or above the floor. Not a degradation, so
	 * no ledger kind; bounded by call cadence (one `turn_end` runs it once per
	 * turn) rather than by an option here.
	 */
	"loop_block",
	/**
	 * #1925: a session event skipped because its ctx was invalidated by a
	 * session replacement or reload. A replaced session can drain a whole
	 * queue of them, so it is rising-edge per event name.
	 */
	"session_event_stale_ctx_skip",
	/**
	 * #2007: a worktree-mutating git command declined because another live
	 * session shares this dirty checkout. Rising edge per checkout root; the
	 * ledger keeps the exact repeat count.
	 */
	"shared_checkout_switch_blocked",
	/**
	 * #2007: `git status` could not report the working-tree state, so the same
	 * command was declined on an UNKNOWN rather than assumed clean.
	 */
	"shared_checkout_probe_failed",
	/** #2356: a notify-stall auxiliary remained uncovered after its bounded
	 * replacement window. Detailed rows are capped per turn; the ledger and
	 * aggregate turn-end row retain the complete count and identity. */
	"lsp_scanner_coverage_gap",
	/** #2358: a busy CPU discriminator deferred notify-stall teardown. */
	"lsp_notify_stall_cpu_busy",
] as const;

export type BoundedPhase = (typeof BOUNDED_TELEMETRY_PHASES)[number];

const REGISTERED_PHASES: ReadonlySet<string> = new Set(
	BOUNDED_TELEMETRY_PHASES,
);

/** Report whether a phase name is in the registry (used by the sweep). */
export function isBoundedTelemetryPhase(phase: string): phase is BoundedPhase {
	return REGISTERED_PHASES.has(phase);
}

/** Hard ceiling on detailed records for one phase within one turn. */
export interface TurnCap {
	limit: number;
	/**
	 * The caller's current turn. It travels with the limit on purpose: it
	 * makes a cap that nobody resets unrepresentable. The counters clear the
	 * first time a call observes a different turn.
	 */
	turnIndex: number;
}

interface BoundedTelemetryCommon {
	/**
	 * Reason text stored with the ledger entry. Ignored without `ledgerKind`.
	 */
	reason?: string;
	capPerTurn?: TurnCap;
}

/**
 * Options for `emitBounded`/`admitBounded`.
 *
 * The union is the point: `risingEdgePer` is only expressible ALONGSIDE a
 * `ledgerKind`, because the edge is DERIVED from the ledger's own tally
 * (`incrementDegradationCount`'s return value) and there is nothing else to
 * derive it from. Asking for a rising edge without a kind is a compile error
 * rather than a guard that silently never fires.
 *
 * `risingEdgePer` has exactly one granularity, `"identity"` — first
 * occurrence per identity this session, the #1716 shape. There is
 * deliberately no phase-wide variant: the ledger tallies by (kind, subject),
 * so a phase-wide edge would need either a second latch (the class this
 * helper exists to prevent) or a subject that erases the identity (the rule
 * this helper exists to enforce).
 */
export type BoundedTelemetryOptions = BoundedTelemetryCommon &
	(
		| {
				/**
				 * Ledger kind that counts EVERY occurrence exactly, including the
				 * ones this helper declines to log in detail. Omit only when the
				 * phase is not a degradation; a failure path without a ledger kind
				 * counts nothing, and the count is what makes an unlogged repeat
				 * visible at all.
				 */
				ledgerKind?: DegradationKind;
				risingEdgePer?: never;
		  }
		| { ledgerKind: DegradationKind; risingEdgePer: "identity" }
	);

/**
 * What the payload may set. `phase`, `ts`, and `pid` belong to the helper and
 * the logger. `filePath` is optional and defaults to the identity: a site
 * whose existing latency.log queries filter on something COARSER than its
 * discriminating identity (#1713's pull records filter on the file path while
 * the identity is path plus source identifier) may set it explicitly. The
 * identity still reaches the record either way, via `metadata.identity`.
 * `type` defaults to `"phase"`.
 */
export type BoundedTelemetryPayload = Omit<
	LatencyEntry,
	"phase" | "filePath" | "ts" | "pid" | "type"
> & {
	filePath?: string;
	/** Defaults to `"phase"`, which every migrated site uses. */
	type?: LatencyEntry["type"];
};

/**
 * Per-turn admission counters, keyed by turn and phase. Multiple turns remain
 * live because async work can finish T1 after T2 has already emitted. The map
 * retains a bounded recent window; work older than that window fails closed
 * rather than reopening an exhausted budget. Session start clears all state.
 */
const MAX_TRACKED_TURN_CAPS = 64;
let turnCounts = new Map<number, Map<string, number>>();
let latestCountedTurnIndex: number | undefined;
let retiredThroughTurnIndex = Number.NEGATIVE_INFINITY;

/**
 * Decide whether this occurrence earns a detailed record, and count it in the
 * ledger either way. Returns `true` when the caller should write the record.
 *
 * Split out from `emitBounded` for the #1705 shape: that site loops over N
 * abandoned records, admits each one, and then writes ONE batched
 * `logLatency` naming only the admitted ones. A helper that could only emit
 * per-call would have turned one record into N.
 */
export function admitBounded(
	phase: BoundedPhase,
	identity: string,
	options: BoundedTelemetryOptions = {},
): boolean {
	try {
		let isRisingEdge = true;
		if (options.ledgerKind !== undefined) {
			// `subject` is the identity, unmodified: the ledger's per-subject
			// entry is what tells a reader WHICH file or method is stuck after
			// the detailed records stop.
			isRisingEdge = incrementDegradationCount({
				kind: options.ledgerKind,
				subject: identity,
				reason: options.reason ?? phase,
			});
		}
		if (options.risingEdgePer !== undefined && !isRisingEdge) return false;
		return admitAgainstTurnCap(phase, options.capPerTurn);
	} catch {
		// Telemetry must never break the observed path. Emitting is the safer
		// failure: an extra record is noise, a swallowed one is a blind spot.
		return true;
	}
}

/**
 * Count every occurrence in the ledger, then write ONE bounded `latency.log`
 * record if this occurrence is admitted. Returns whether the record was
 * written, so a caller can branch on it (all four migrated sites either
 * ignore it or, in #1705's case, use `admitBounded` directly).
 */
export function emitBounded(
	phase: BoundedPhase,
	identity: string,
	payload: BoundedTelemetryPayload,
	options: BoundedTelemetryOptions = {},
): boolean {
	try {
		if (!admitBounded(phase, identity, options)) return false;
		logLatency({
			...payload,
			type: payload.type ?? "phase",
			phase,
			// `filePath` is what existing latency.log queries filter on, so a site
			// may keep a coarser one; `metadata.identity` below always carries the
			// full discriminating identity. Aggregation that loses WHICH subject
			// is stuck is the failure AGENTS.md names.
			filePath: payload.filePath ?? identity,
			metadata: { ...payload.metadata, identity },
		});
		return true;
	} catch {
		// Telemetry must never break the observed path.
		return false;
	}
}

/**
 * Apply the per-turn ceiling. Separated so the turn-rollover clear happens in
 * exactly one place: a cap and its reset drifting apart is how #1733's
 * compensating-pair guards got past review.
 */
function admitAgainstTurnCap(
	phase: string,
	cap: BoundedTelemetryOptions["capPerTurn"],
): boolean {
	if (cap === undefined) return true;
	if (cap.turnIndex <= retiredThroughTurnIndex) return false;

	let counts = turnCounts.get(cap.turnIndex);
	if (!counts) {
		if (turnCounts.size >= MAX_TRACKED_TURN_CAPS) {
			const oldestTrackedTurn = Math.min(...turnCounts.keys());
			if (cap.turnIndex < oldestTrackedTurn) return false;
			turnCounts.delete(oldestTrackedTurn);
			retiredThroughTurnIndex = Math.max(
				retiredThroughTurnIndex,
				oldestTrackedTurn,
			);
		}
		counts = new Map();
		turnCounts.set(cap.turnIndex, counts);
	}
	latestCountedTurnIndex = Math.max(
		latestCountedTurnIndex ?? cap.turnIndex,
		cap.turnIndex,
	);
	const used = counts.get(phase) ?? 0;
	if (used >= cap.limit) return false;
	counts.set(phase, used + 1);
	return true;
}

/**
 * Session-boundary/test reset. The rising-edge state is NOT here — it lives
 * in the degradation ledger, which `handleSessionStart` already re-arms via
 * `resetDegradationLedger`. Only the per-turn counters are this module's own,
 * and they need this because turn numbering restarts at 0 each session.
 */
export function resetBoundedTelemetry(): void {
	turnCounts = new Map();
	latestCountedTurnIndex = undefined;
	retiredThroughTurnIndex = Number.NEGATIVE_INFINITY;
}

/** Test-only: one turn's live admission count for a phase. */
export function _boundedTurnCountForTest(
	phase: string,
	turnIndex = latestCountedTurnIndex,
): number {
	if (turnIndex === undefined) return 0;
	return turnCounts.get(turnIndex)?.get(phase) ?? 0;
}

/** Test-only: number of turn buckets retained by the bounded counter. */
export function _boundedTrackedTurnsForTest(): number {
	return turnCounts.size;
}
