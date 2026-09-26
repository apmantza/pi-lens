/**
 * Tier-aware cascade-lane wait policy (#458, re-scope №2).
 *
 * The cascade/deferred lane (`computeCascadeForFile`'s neighbor-touch fan-out
 * in `clients/dispatch/integration.ts`) actively opens neighbor files against
 * their LSP client and waits up to a per-touch budget (~1000ms cold-snapshot /
 * 2000ms warm) for `textDocument/publishDiagnostics` before deciding the
 * neighbor is clean. For a Tier-3 server — one that is `push-only` AND known
 * to publish NOTHING on a clean→clean transition (see
 * docs/lsp-capability-matrix.md; today that's typescript-language-server, the
 * lone core-set instance) — that wait can never distinguish "clean" from
 * "still analyzing"; it always burns its full budget. Dogfooding measured
 * ~221 such `lsp_diagnostics_timeout` events/day.
 *
 * pi 0.80.6's `agent_settled` quiet window (#483, `clients/quiet-window.ts`)
 * gives the cascade lane a place to resolve that ambiguity OUT of the
 * per-touch budget: fire the touch (didOpen/didChange still happens, so the
 * server starts real work), record it as outstanding, and reconcile against
 * whatever landed in the client's diagnostics cache by the time the agent run
 * goes idle. A touch nothing arrived for by then is recorded `unresolved` —
 * never silently treated as `clean` (the #240 doctrine: a missing answer is
 * not an affirmative answer).
 *
 * This module is deliberately NOT hardcoded to server names for the "should
 * this file skip its in-lane wait" question: it reads the live capability
 * snapshot's `workspaceDiagnosticsSupport.mode` (from
 * `detectWorkspaceDiagnosticsSupport`, cached at `initialize`) and combines it
 * with the `silentOnClean` marker on that server's `DiagnosticStrategy`
 * (`wait-policy/strategies.ts`) — the same per-server behavioral-knowledge table
 * the rest of the LSP layer already uses. A server with no live snapshot yet,
 * or whose mode isn't `push-only`, or that isn't marked `silentOnClean`, is
 * NOT tier-3 — the caller keeps today's full in-lane wait. Fail-safe is
 * always "wait like before".
 *
 * Native TS7 is the cascade-only exception. It is not silent on clean, but
 * its publication does not settle inside the cold-snapshot budget. Cascade
 * classifies it as `collect-later`, sends the same no-wait touch, and
 * reconciles its later per-file push or pull publication. The shared server
 * policy remains `waits`, so main-lane behavior does not change.
 *
 * #524/#529/#541/#558: a server id can now be backed by more than one actual
 * binary — "typescript" is classic typescript-language-server OR TS7's
 * native `tsc --lsp --stdio` (PR #526). PR #526 originally routed the
 * native-ts7 variant through the fail-safe "waits" path because
 * `silentOnClean` had only been measured against the classic server; #541
 * (2026-07-11) briefly lifted that exclusion after a clean-signal probe run
 * appeared to show native-ts7 silent too. A follow-up dual-environment
 * re-measurement (2026-07-12, nightly CI on Linux AND a live local run on
 * Windows dev, same `typescript@7.0.2` both times) found native-ts7 now
 * publishes 2 version-less diagnostic sets on the clean transition
 * (`cleanPubs=2(v:0)`) — it is NOT silent. Classic is unaffected and
 * confirmed still silent (`cleanPubs=0(v:0)`) in the same run. This is
 * therefore an EVIDENCE-BASED revert, not the original unverified caution:
 * native-ts7's clean-signal behavior IS known, and it is "publishes, not
 * silent". The shared classifier still routes a native-ts7 snapshot through
 * `waits`. The cascade-only wrapper routes it through `collect-later` because
 * the measured publication arrives after the in-lane budget. The shared
 * `silentOnClean` flag stays `true` for classic.
 * `scripts/probe-clean-signal.mjs`'s drift check no
 * longer compares native-ts7 rows against the shared marker (it now expects
 * `false` for them explicitly) — see that file's header for the regression
 * watch this sets up for a future TS7 build that becomes silent again.
 */

import { logCascade } from "../cascade-logger.js";
import { incrementDegradationCount } from "../degradation-ledger.js";
import { logLatency } from "../latency-logger.js";
import { normalizeMapKey } from "../path-utils.js";
import { registerQuietWindowTask } from "../quiet-window.js";
import type { LSPDiagnostic } from "./client.js";
import type { LSPService } from "./index.js";

import {
	classifyCascadeWaitTier as classifySharedCascadeWaitTier,
	classifyServerWaitTier,
	resolvePrimaryServerForWaitPolicy,
	type CascadeWaitTier as SharedCascadeWaitTier,
} from "./wait-policy/classification.js";

export { classifyServerWaitTier };
// The observed-latency half of the collect-later policy is shared with CLI
// runners. Keep this module as the LSP-facing export seam without duplicating
// the state machine in the cascade classifier.
export {
	classifyObservedRunner,
	observeRunnerLatency,
	resetObservedRunnerLatency,
	type CollectLaterTier,
} from "../dispatch/collect-later-tier.js";

/** Cascade-only extension of the shared wait policy. Native TS7 keeps the
 * shared `waits` policy everywhere else, but cascade collects its late pull
 * result outside the bounded in-lane fan-out. */
export type CascadeWaitTier = SharedCascadeWaitTier | "collect-later";

/**
 * The cascade lane's wait tier for `filePath`. DELEGATES to the shared
 * `wait-policy/classification.ts` rule — this wrapper adds exactly one
 * cascade-only override on top of it (native TS7's push-only snapshot →
 * `collect-later`) and never re-implements the classification itself.
 *
 * #1444 coverage tradeoff: the no-wait touch this tier selects is
 * `clientScope: "primary"`, and the tier itself is decided from the PRIMARY
 * (non-auxiliary) server alone. That tradeoff already existed for
 * `tier3-silent`; the override enlarges the population it applies to — every
 * native-TS7 TypeScript neighbour now takes the no-wait path too, so an
 * auxiliary server configured for those files no longer gets touched in-lane
 * for them (its findings arrive via the next per-edit dispatch, as they
 * already did for classic tier-3 files).
 */
export function classifyCascadeWaitTier(
	lspService: Pick<LSPService, "getCapabilitySnapshots">,
	filePath: string,
	snapshots: Awaited<ReturnType<LSPService["getCapabilitySnapshots"]>>,
): CascadeWaitTier {
	const primary = resolvePrimaryServerForWaitPolicy(filePath, snapshots);
	if (
		primary?.serverId === "typescript" &&
		primary.snapshot?.launchVariant === "native-ts7" &&
		primary.snapshot.workspaceDiagnosticsSupport?.mode === "push-only"
	) {
		return "collect-later";
	}
	return classifySharedCascadeWaitTier(lspService, filePath, snapshots);
}

// --- Kill switch (lazy, memoized — house style per clients/runtime-config.ts /
// clients/quiet-window.ts's isQuietWindowEnabled) ---

let _enabledCache: boolean | undefined;

/** `PI_LENS_TIER_AWARE_CASCADE=0` disables the whole feature: every cascade
 * touch waits in-lane exactly as it did before #458, no outstanding-touch
 * bookkeeping, no reconcile task registered. */
export function isTierAwareCascadeEnabled(): boolean {
	if (_enabledCache !== undefined) return _enabledCache;
	_enabledCache = process.env.PI_LENS_TIER_AWARE_CASCADE !== "0";
	return _enabledCache;
}

/** Test-only: clear the memoized kill-switch read. */
export function _resetTierAwareCascadeEnabledForTests(): void {
	_enabledCache = undefined;
}

// --- Outstanding-touch registry -------------------------------------------

interface OutstandingTouch {
	filePath: string;
	serverId: string;
	/**
	 * Sampled BEFORE the touch's didOpen/didChange notify is sent, so any
	 * publish that lands after the notify — including one landing in the
	 * notify→record gap — reads as post-touch at reconcile time. Compared
	 * against the client's PER-FILE publish timestamp (`getAllDiagnostics()`'s
	 * `ts`), never against a client-wide signal: a cascade touches multiple
	 * neighbors on the SAME client, so a client-wide counter advanced by
	 * neighbor A's publish must not "prove" neighbor B clean (#240).
	 */
	touchedAt: number;
}

// Keyed by normalized file path. A later touch for the same file simply
// replaces the earlier entry (only the most recent touch matters — an
// older touch's diagnostics, if they ever arrive, are still a strict superset
// concern the newer touch already re-supersedes via didOpen/didChange).
//
// #1899: the registry is drained in full by every reconcile sweep, but nothing
// bounded it BETWEEN sweeps. The sweep runs on pi's `agent_settled` quiet
// window, and a session can go a long time without one — dogfood logs show
// sweeps up to 52 minutes apart. So the two bounds below are the registry's
// own, independent of when a sweep arrives:
//
//   - `MAX_OUTSTANDING_TOUCHES` caps the entry count. Entries are held in
//     touch order (see `recordOutstandingCascadeTouch`), so eviction takes the
//     oldest touch at O(1).
//   - `OUTSTANDING_TOUCH_MAX_AGE_MS` caps how long a touch stays reconcilable.
//     Past it, the touch is discarded rather than answered: re-injecting a
//     neighbour error, or clearing a footer entry, from a touch fired that
//     long ago reports a state the agent has already moved past.
//
// Both constants are sized from the 2026-08-09..20 dogfood window (cascade.log,
// 67 sweeps / 756 entries): the largest single sweep held 53 entries, and a
// 15-minute age bound retains 72 of the 80 outcomes that ever resolved (90%)
// while discarding the tail that resolved after ~26-52 minutes.
const MAX_OUTSTANDING_TOUCHES = 256;
const OUTSTANDING_TOUCH_MAX_AGE_MS = 15 * 60_000;

const _outstandingTouches = new Map<string, OutstandingTouch>();

/** Entries dropped by the age bound since the last sweep reported. */
let _expiredSinceLastSweep = 0;
/** Entries dropped by the size cap since the last sweep reported. */
let _evictedSinceLastSweep = 0;

/**
 * Drop every entry older than `OUTSTANDING_TOUCH_MAX_AGE_MS`. The map is held
 * in touch order, so the expired entries are a prefix and the walk stops at
 * the first live one.
 */
function pruneExpiredOutstandingTouches(now: number): void {
	for (const [key, touch] of _outstandingTouches) {
		if (now - touch.touchedAt <= OUTSTANDING_TOUCH_MAX_AGE_MS) break;
		_outstandingTouches.delete(key);
		_expiredSinceLastSweep++;
	}
}

/**
 * Record a Tier-3 cascade touch that skipped its in-lane wait. Called right
 * after the (still-performed) didOpen/didChange notify, before returning
 * without waiting. `touchedAt` must be sampled BEFORE the notify (see the
 * field doc) so the reconcile comparison can never misread a publish that
 * raced the record as pre-touch.
 *
 * #1899: also enforces the registry's two bounds. The `delete` before the
 * `set` is load-bearing — `Map.set` on an existing key keeps the key's
 * ORIGINAL insertion position, so without it a re-touched file would keep a
 * stale position and both the age prefix walk and the oldest-first eviction
 * would pick the wrong entry.
 */
export function recordOutstandingCascadeTouch(entry: OutstandingTouch): void {
	const key = normalizeMapKey(entry.filePath);
	_outstandingTouches.delete(key);
	// `Date.now()`, not `entry.touchedAt`: the caller samples `touchedAt` before
	// its notify, so it trails real time, and the age bound is a statement about
	// the clock rather than about the newest touch's own stamp.
	pruneExpiredOutstandingTouches(Date.now());
	_outstandingTouches.set(key, entry);
	while (_outstandingTouches.size > MAX_OUTSTANDING_TOUCHES) {
		const oldest = _outstandingTouches.keys().next();
		if (oldest.done) break;
		_outstandingTouches.delete(oldest.value);
		_evictedSinceLastSweep++;
		// Bounded by construction: one ledger tally per session, not per
		// eviction event. The subject is the cap itself rather than the evicted
		// path — the discriminating fact is "this session overflowed the tier-3
		// backlog", and per-path subjects would unbound the ledger group.
		incrementDegradationCount({
			kind: "cascade-tier3-backlog-evicted",
			subject: `cap=${MAX_OUTSTANDING_TOUCHES}`,
			reason:
				"tier-3 outstanding-touch registry hit its cap before a quiet-window reconcile drained it; the oldest touch was dropped unanswered",
		});
	}
}

/**
 * #1910: session-boundary reset for the outstanding-touch registry and its
 * sweep-scoped `_expiredSinceLastSweep`/`_evictedSinceLastSweep` counters.
 * Both predate #1899 and were never wired into `handleSessionStart` — a
 * session replacement inherited the prior session's outstanding touches, and
 * a stray eviction/expiry landing between a sweep and the boundary attributed
 * its count to the NEXT session's first reconcile gauge. Wired primary-only,
 * same as every other entry in that reset block: a concurrently-live
 * secondary never reaches `handleSessionStart` at all (the #473 guard in
 * index.ts), so it can never race this reset against the still-live
 * primary's outstanding touches.
 */
export function resetCascadeTierSessionState(): void {
	_outstandingTouches.clear();
	_expiredSinceLastSweep = 0;
	_evictedSinceLastSweep = 0;
}

/** Test-only: clear the outstanding-touch registry between test cases. */
export function _resetOutstandingCascadeTouchesForTests(): void {
	resetCascadeTierSessionState();
}

/** Test-only: peek at the registry without mutating it. */
export function _getOutstandingCascadeTouchesForTests(): OutstandingTouch[] {
	return [...(_outstandingTouches.values() as Iterable<OutstandingTouch>)];
}

/**
 * Test-only: peek at the sweep-scoped expired/evicted counters without
 * mutating them. Exists so a probe of `resetCascadeTierSessionState` can
 * assert on THESE counters directly, rather than only on the registry map —
 * a future counter added here and left out of the reset would otherwise
 * stay invisible to any probe that only checks the map went empty.
 */
export function _getCascadeTierSweepCountersForTests(): {
	expired: number;
	evicted: number;
} {
	return { expired: _expiredSinceLastSweep, evicted: _evictedSinceLastSweep };
}

/**
 * #1899: WHY a touch stayed unresolved. Five distinct causes used to collapse
 * into the single word `unresolved`, which is what made the dogfood backlog
 * unreadable: 676 of 756 outcomes were `unresolved` with no way to tell the
 * EXPECTED case (a `silentOnClean` server has nothing to say about a clean
 * neighbour) from a real degradation (the server went cold, or the lookup
 * threw). Same doctrine as the repo's empty-result rule — an absent answer
 * must still say which kind of absence it is.
 */
export type UnresolvedReason =
	/** No warm client for the file — the server was idle-reaped since the touch. */
	| "warm-miss"
	/** A warm client exists, but it is a different server than the one touched. */
	| "server-mismatch"
	/** The client holds no diagnostics entry for this file at all. */
	| "no-publish"
	/** An entry exists, but its publish predates the touch — nothing new landed. */
	| "no-publish-since-touch"
	/** The client lookup threw. */
	| "error";

export interface ReconcileOutcome {
	filePath: string;
	serverId: string;
	outcome: "resolved-found" | "resolved-clean" | "unresolved";
	/** Present only for `unresolved`. */
	unresolvedReason?: UnresolvedReason;
	ageMs: number;
	diagnosticCount?: number;
	/**
	 * #1023: the actual published diagnostics for a `resolved-found` outcome, so
	 * the reconcile task can RE-INJECT them into the agent-facing cascade output
	 * (a cold-snapshot neighbor error that resolved after the turn ended must not
	 * stay logs-only). Populated only for `resolved-found`.
	 */
	diagnostics?: LSPDiagnostic[];
	/**
	 * #1444: the client's PER-FILE publish timestamp that resolved this touch
	 * (`getAllDiagnostics()`'s `ts`). Populated for both resolved outcomes; the
	 * footer reconcile stamps it as the observation time so a late clean is not
	 * recorded as observed "now". Never set for `unresolved`.
	 */
	publishedAt?: number;
}

/**
 * Reconcile every outstanding Tier-3 touch against the LSP client's current
 * diagnostics cache. For each:
 *   - If the client holds a PER-FILE diagnostics entry for the touched file
 *     whose publish timestamp (`getAllDiagnostics()`'s `ts` — the max of the
 *     push/pull timestamps for that file, client.ts) is newer than the
 *     touch's pre-notify `touchedAt`, something published for THAT FILE since
 *     the touch — record `resolved-found` (diagnostics present) or
 *     `resolved-clean` (empty, but PROVEN empty by an actual publish for that
 *     file after the touch). A client-WIDE signal is deliberately not used:
 *     it advances on any file's publish, so it could falsely "prove" a silent
 *     neighbor clean when a sibling neighbor published (#240).
 *   - If nothing published for the file by settle time, record `unresolved` —
 *     per the #240 doctrine this is NEVER treated as clean.
 *
 * Client lookup is WARM-ONLY (`getWarmClientForFile`): the quiet window must
 * never resurrect an idle-reaped server (a full tsserver spawn + cold index)
 * just to write a log line. A warm-miss ⇒ `unresolved`.
 *
 * Always drains the whole registry (each entry is independently resolved;
 * one entry's client lookup failing doesn't block the rest) and never
 * throws — callers (the quiet-window task) must be fail-safe.
 */
export async function reconcileOutstandingCascadeTouches(
	lspService: Pick<LSPService, "getWarmClientForFile">,
): Promise<ReconcileOutcome[]> {
	const outcomes: ReconcileOutcome[] = [];
	// #1899: the age bound applies at sweep time too, not only at record time —
	// a registry that received no further touches would otherwise hand the sweep
	// entries of unbounded age.
	pruneExpiredOutstandingTouches(Date.now());
	const entries = [..._outstandingTouches.entries()];
	_outstandingTouches.clear();

	for (const [key, touch] of entries) {
		const ageMs = Date.now() - touch.touchedAt;
		try {
			const spawned = await lspService.getWarmClientForFile(touch.filePath);
			if (!spawned || spawned.client.serverId !== touch.serverId) {
				outcomes.push({
					filePath: touch.filePath,
					serverId: touch.serverId,
					outcome: "unresolved",
					unresolvedReason: spawned ? "server-mismatch" : "warm-miss",
					ageMs,
				});
				continue;
			}
			const entry = spawned.client
				.getAllDiagnostics()
				.get(normalizeMapKey(touch.filePath));
			if (!entry || entry.ts <= touch.touchedAt) {
				// No per-file publish since the touch (or ever) — a missing answer
				// is not a clean answer.
				outcomes.push({
					filePath: touch.filePath,
					serverId: touch.serverId,
					outcome: "unresolved",
					unresolvedReason: entry ? "no-publish-since-touch" : "no-publish",
					ageMs,
				});
				continue;
			}
			const found = entry.diags.length > 0;
			outcomes.push({
				filePath: touch.filePath,
				serverId: touch.serverId,
				outcome: found ? "resolved-found" : "resolved-clean",
				ageMs,
				diagnosticCount: entry.diags.length,
				publishedAt: entry.ts,
				// #1023: carry the diagnostics so the task can re-surface them.
				...(found && { diagnostics: entry.diags }),
			});
		} catch (err) {
			outcomes.push({
				filePath: touch.filePath,
				serverId: touch.serverId,
				outcome: "unresolved",
				unresolvedReason: "error",
				ageMs,
			});
			logLatency({
				type: "phase",
				phase: "cascade_tier3_reconcile_error",
				filePath: key,
				durationMs: 0,
				metadata: { error: String(err) },
			});
		}
	}
	return outcomes;
}

let _reconcileTaskRegistered = false;

/** #1023: a `resolved-found` neighbor error to re-inject into agent-facing output. */
export interface ResolvedFoundNeighbor {
	filePath: string;
	serverId: string;
	diagnostics: LSPDiagnostic[];
	/** #3168 F3: the #1444 publish stamp, threaded so a run built from this
	 * neighbor carries its own observation time — the carried-run age label
	 * renders from it instead of claiming no stamp exists. */
	publishedAt?: number;
}

export interface CascadeTierReconcileOptions {
	/**
	 * #1023: called (best-effort) for each `resolved-found` outcome so the caller
	 * can RE-INJECT the neighbor error through the same turn-end cascade seam
	 * instead of leaving it logs-only. Wired in index.ts to build a CascadeRun via
	 * the existing neighbor→turn-end formatting and append it to the runtime.
	 * Never called for `resolved-clean`/`unresolved`.
	 */
	onResolvedFound?: (neighbor: ResolvedFoundNeighbor) => void;
	/**
	 * #1444: called (best-effort) for each `resolved-clean` outcome — a per-file
	 * publish that landed AFTER the touch and carried no errors, i.e. a
	 * CONFIRMED clean observation by the same standard the in-lane path uses
	 * (`isConfirmedTouch`, `clients/dispatch/integration.ts`). Wired in index.ts
	 * to clear the neighbour's now-stale LSP-error entries from the footer, which
	 * the skipped in-lane wait could not do. Never called for
	 * `resolved-found`/`unresolved` (a missing answer is not a clean answer).
	 */
	onResolvedClean?: (neighbor: {
		filePath: string;
		serverId: string;
		publishedAt: number;
	}) => void;
}

/**
 * Register the Tier-3 reconcile task with the quiet-window scheduler
 * (`clients/quiet-window.ts`). Idempotent — safe to call more than once
 * (e.g. multiple extension activations in tests).
 */
export function registerCascadeTierReconcileTask(
	getLspService: () => Pick<LSPService, "getWarmClientForFile">,
	options: CascadeTierReconcileOptions = {},
): void {
	if (_reconcileTaskRegistered) return;
	_reconcileTaskRegistered = true;

	registerQuietWindowTask("cascade_tier3_reconcile", async (context) => {
		if (!isTierAwareCascadeEnabled()) return;
		const outcomes = await reconcileOutstandingCascadeTouches(getLspService());

		// #1023: re-inject each resolved-found neighbor error so it reaches the
		// agent (previously logs-only). #1444: hand each resolved-CLEAN outcome to
		// the footer reconcile for the mirror-image case. Isolated per-outcome — a
		// throwing callback must not drop the log line or the sibling deliveries.
		for (const o of outcomes) {
			try {
				if (o.outcome === "resolved-found" && o.diagnostics?.length) {
					const neighbor: ResolvedFoundNeighbor = {
						filePath: o.filePath,
						serverId: o.serverId,
						diagnostics: o.diagnostics,
						...(o.publishedAt !== undefined
							? { publishedAt: o.publishedAt }
							: {}),
					};
					const deliver = () => options.onResolvedFound?.(neighbor);
					// #3499: the re-injection appends to the runtime shared with a
					// same-cwd replacement; drop it if the window's session is gone.
					if (context)
						context.sessionGeneration.guardedWrite(o.filePath, deliver);
					else deliver();
				} else if (o.outcome === "resolved-clean" && o.publishedAt != null) {
					// #1444: the stale-footer half of the same honesty problem — the
					// neighbour proved clean, but only after the in-lane wait was
					// skipped, so nothing has cleared its earlier error entries.
					options.onResolvedClean?.({
						filePath: o.filePath,
						serverId: o.serverId,
						publishedAt: o.publishedAt,
					});
				}
			} catch {
				// best-effort surfacing; the log below is the durable record.
			}
		}

		let resolvedFound = 0;
		let resolvedClean = 0;
		let unresolved = 0;
		let ageSumMs = 0;
		let maxAgeMs = 0;
		const unresolvedByReason: Partial<Record<UnresolvedReason, number>> = {};
		for (const o of outcomes) {
			if (o.outcome === "resolved-found") resolvedFound++;
			else if (o.outcome === "resolved-clean") resolvedClean++;
			else {
				unresolved++;
				const reason = o.unresolvedReason ?? "no-publish";
				unresolvedByReason[reason] = (unresolvedByReason[reason] ?? 0) + 1;
			}
			ageSumMs += o.ageMs;
			if (o.ageMs > maxAgeMs) maxAgeMs = o.ageMs;
		}
		const avgAgeMs = outcomes.length
			? Math.round(ageSumMs / outcomes.length)
			: 0;

		// #1899: emitted on EVERY sweep, including the empty one. The backlog's
		// size was previously observable only when it was non-empty, so "the
		// queue is drained" and "the sweep never ran" read identically in
		// cascade.log. This record is the backlog gauge: what the sweep drained,
		// what the two bounds dropped since the last sweep, and what the bounds
		// are, so a reader never has to know the constants to judge the numbers.
		logCascade({
			phase: "cascade_tier3_reconcile",
			filePath: "<quiet-window>",
			metadata: {
				count: outcomes.length,
				resolvedFound,
				resolvedClean,
				unresolved,
				unresolvedByReason,
				avgAgeMs,
				maxAgeMs,
				expired: _expiredSinceLastSweep,
				evicted: _evictedSinceLastSweep,
				capacity: MAX_OUTSTANDING_TOUCHES,
				maxAgeCapMs: OUTSTANDING_TOUCH_MAX_AGE_MS,
				outcomes,
			},
		});
		_expiredSinceLastSweep = 0;
		_evictedSinceLastSweep = 0;
	});
}

/** Test-only: undo registerCascadeTierReconcileTask's idempotency guard. */
export function _resetCascadeTierReconcileRegistrationForTests(): void {
	_reconcileTaskRegistered = false;
}
