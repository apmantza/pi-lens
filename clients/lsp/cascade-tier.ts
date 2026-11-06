/**
 * Tier-aware cascade-lane wait policy (#458, re-scope №2; #4485).
 *
 * The cascade lane (`computeCascadeForFile`'s neighbor-touch fan-out in
 * `clients/dispatch/integration.ts`) opens each neighbor against its LSP
 * client and needs an answer for it: its errors, or a confirmed clean. How it
 * gets one depends on the server's diagnostics model, read from the live
 * capability snapshot (`workspaceDiagnosticsSupport.mode`, cached at
 * `initialize`) and the `silentOnClean` marker on the server's
 * `DiagnosticStrategy` (`wait-policy/strategies.ts`), never from a hardcoded
 * server list. A server with no live snapshot yet, or whose mode is not
 * `push-only`, or that is not marked `silentOnClean`, keeps the full in-lane
 * wait. Fail-safe is always "wait like before".
 *
 * - `command-pull` (#4485): a `silentOnClean` push-only server can still be
 *   asked. Classic typescript-language-server advertises
 *   `typescript.tsserverRequest`, and the in-lane touch's #707 sync confirm
 *   (`clients/lsp/index.ts`) uses it to get tsserver's verdict in ~320 ms.
 *   The cascade sends these neighbors down the normal waiting touch.
 * - `tier3-silent` without the command (marksman, a classic TS build that
 *   does not advertise it) and `collect-later` (native TS7 on a push-only
 *   snapshot): the cascade touches without collecting and waits up to
 *   `SILENT_PUSH_WAIT_MS` for a publish newer than the touch
 *   (integration.ts). A publish answers the neighbor; silence leaves it
 *   unconfirmed, which the run carries and turn_end names. Silence is never
 *   read as clean (the #240 doctrine).
 *
 * Only that silent leftover is recorded here as outstanding. turn_end peeks
 * the registry once after its settle (`peekOutstandingCascadeTouches`), the
 * `agent_settled` quiet window reconciles what is left
 * (`registerCascadeTierReconcileTask`), and an entry reaching the age bound
 * is read once more before it goes, so what it held is delivered or logged
 * instead of vanishing. Before #4485 every classic TS neighbor took this
 * path, and most answers expired unread: 77% of real neighbor outcomes were
 * deferred, and 58 runs whose every neighbor was deferred read
 * `no_neighbors`.
 *
 * Native TS7 is the cascade-only exception. Its publication does not settle
 * inside the cold-snapshot budget, so the cascade classifies it as
 * `collect-later`, and the shared server policy remains `waits`, so
 * main-lane behavior does not change. It is never `tier3-silent`: for that
 * tier `touchFile`'s silent-confirm gate reads a lapsed wait as clean (the
 * cascade lane itself leaves silence unconfirmed), and nothing shows that a
 * push-only TS7 build publishes a file's errors inside the budget. Native TS7
 * 7.0.2 is a pull server (#5348), so this path serves a push-only snapshot
 * only. `scripts/probe-clean-signal.mjs` reports a silent native launch as a
 * drift finding for a human to decide.
 */

import { logCascade } from "../cascade-logger.js";
import { BoundedFifoMap } from "../bounded-cache.js";
import { incrementDegradationCount } from "../degradation-ledger.js";
import { logLatency } from "../latency-logger.js";
import { normalizeMapKey } from "../path-utils.js";
import { registerQuietWindowTask } from "../quiet-window.js";
import type { GenerationHandle } from "../generation-guard.js";
import type { LSPClientInfo, LSPDiagnostic } from "./client.js";
import type { LSPService } from "./index.js";
import { isTsgoLaunchVariant } from "./server-traits.js";

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
 * shared `waits` policy everywhere else, but cascade waits for its publish
 * on the silent-push path. `command-pull` is a `tier3-silent` server the
 * cascade can still ask (#4485). */
export type CascadeWaitTier =
	| SharedCascadeWaitTier
	| "collect-later"
	| "command-pull";

/**
 * typescript-language-server's command channel to tsserver, which the #707
 * sync confirm sends `projectInfo` and `geterr` through. Owned by
 * `clients/lsp/tsserver-sync.ts`, which does not export it; spelled once
 * more here so the cascade can tell a server it can ask from one it cannot.
 */
const TSSERVER_REQUEST_COMMAND = "typescript.tsserverRequest";

/**
 * The cascade lane's wait tier for `filePath`. DELEGATES to the shared
 * `wait-policy/classification.ts` rule — this wrapper adds two cascade-only
 * overrides on top of it (native TS7's push-only snapshot → `collect-later`;
 * a `tier3-silent` classic tsserver that advertises the sync command →
 * `command-pull`, #4485) and never re-implements the classification itself.
 *
 * #1444 coverage tradeoff: the silent-push touch these tiers select is
 * `clientScope: "primary"`, and the tier itself is decided from the PRIMARY
 * (non-auxiliary) server alone, so an auxiliary server configured for those
 * files is not touched in-lane for them (its findings arrive via the next
 * per-edit dispatch). `command-pull` takes the waiting touch, which is
 * `clientScope: "primary"` as well (#1720).
 */
export function classifyCascadeWaitTier(
	lspService: Pick<LSPService, "getCapabilitySnapshots">,
	filePath: string,
	snapshots: Awaited<ReturnType<LSPService["getCapabilitySnapshots"]>>,
): CascadeWaitTier {
	const primary = resolvePrimaryServerForWaitPolicy(filePath, snapshots);
	if (
		primary?.serverId === "typescript" &&
		isTsgoLaunchVariant(primary.snapshot?.launchVariant) &&
		primary.snapshot?.workspaceDiagnosticsSupport?.mode === "push-only"
	) {
		return "collect-later";
	}
	const shared = classifySharedCascadeWaitTier(lspService, filePath, snapshots);
	// #4485: the #707 sync confirm needs the server id and the command, the
	// same two facts its own eligibility gate checks (`clients/lsp/index.ts`).
	if (
		shared === "tier3-silent" &&
		primary?.serverId === "typescript" &&
		primary.snapshot?.advertisedCommands?.includes(TSSERVER_REQUEST_COMMAND)
	) {
		return "command-pull";
	}
	return shared;
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

/** The touched client, as much of it as a registry read needs. */
export type OutstandingTouchClient = Pick<
	LSPClientInfo,
	"serverId" | "getAllDiagnostics"
> & { isAlive?: () => boolean };

interface OutstandingTouch {
	filePath: string;
	serverId: string;
	/**
	 * #4485: the client the touch went to, for the synchronous reads (turn_end's
	 * peek and the expiry read), which cannot await `getWarmClientForFile`.
	 * Weak, so the registry never keeps an idle-reaped client alive; a
	 * collected or dead client reads as no answer.
	 */
	client?: WeakRef<OutstandingTouchClient>;
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

// Insertion order IS touch order, and the size cap lives in the map's own
// `set` (#4570: was a hand-rolled `while (size > cap)` evict-oldest block).
const _outstandingTouches = new BoundedFifoMap<string, OutstandingTouch>(
	MAX_OUTSTANDING_TOUCHES,
);

/** Entries dropped by the age bound since the last sweep reported. */
let _expiredSinceLastSweep = 0;
/** Entries dropped by the size cap since the last sweep reported. */
let _evictedSinceLastSweep = 0;

/** The paths an expiry or peek row lists, at most. */
const MAX_LOGGED_PATHS = 20;

/** Where a delivery from a synchronous read runs: the session's write guard. */
type DeliveryGuard = Pick<GenerationHandle, "guardedWrite">;

/**
 * Drop every entry older than `OUTSTANDING_TOUCH_MAX_AGE_MS`. The map is held
 * in touch order, so the expired entries are a prefix and the walk stops at
 * the first live one.
 *
 * #4485: each expired entry is read once from its touched client before it
 * goes. An answer is delivered like any other late answer; the sweep writes
 * one `cascade_tier3_expired` row naming what expired and what it held.
 */
function pruneExpiredOutstandingTouches(
	now: number,
	guard?: DeliveryGuard,
	reads: ClientReads = new Map(),
): void {
	const expired: OutstandingTouch[] = [];
	for (const [key, touch] of _outstandingTouches) {
		if (now - touch.touchedAt <= OUTSTANDING_TOUCH_MAX_AGE_MS) break;
		_outstandingTouches.delete(key);
		_expiredSinceLastSweep++;
		expired.push(touch);
	}
	if (expired.length === 0) return;
	let found = 0;
	let clean = 0;
	for (const touch of expired) {
		const outcome = readTouchedClient(touch, now, reads);
		if (!outcome) continue;
		if (outcome.outcome === "resolved-found") found++;
		else clean++;
		deliverResolvedOutcome(outcome, guard);
	}
	logCascade({
		phase: "cascade_tier3_expired",
		filePath: "<cascade-registry>",
		metadata: {
			count: expired.length,
			found,
			clean,
			unanswered: expired.length - found - clean,
			maxAgeCapMs: OUTSTANDING_TOUCH_MAX_AGE_MS,
			paths: expired.slice(0, MAX_LOGGED_PATHS).map((t) => t.filePath),
			...(expired.length > MAX_LOGGED_PATHS && {
				pathsTruncated: expired.length - MAX_LOGGED_PATHS,
			}),
		},
	});
}

/**
 * One sweep's reads of each touched client's per-file diagnostics.
 * `getAllDiagnostics` rebuilds the map over every file the client tracks, so
 * a sweep reads it once per client, not once per touch (#4495 review F3).
 */
type ClientReads = Map<
	OutstandingTouchClient,
	ReturnType<OutstandingTouchClient["getAllDiagnostics"]>
>;

/**
 * #4485: a synchronous read of one touch against the client it went to. The
 * same per-file rule as the async reconcile below (a publish for THAT file,
 * stamped after the pre-notify `touchedAt`); anything less is no answer.
 */
function readTouchedClient(
	touch: OutstandingTouch,
	now: number,
	reads: ClientReads,
): ReconcileOutcome | undefined {
	const client = touch.client?.deref();
	if (!client || client.serverId !== touch.serverId) return undefined;
	if (client.isAlive?.() === false) return undefined;
	let all = reads.get(client);
	if (all === undefined) {
		all = client.getAllDiagnostics();
		reads.set(client, all);
	}
	const entry = all.get(normalizeMapKey(touch.filePath));
	if (!entry || entry.ts <= touch.touchedAt) return undefined;
	const found = entry.diags.length > 0;
	return {
		filePath: touch.filePath,
		serverId: touch.serverId,
		outcome: found ? "resolved-found" : "resolved-clean",
		ageMs: now - touch.touchedAt,
		diagnosticCount: entry.diags.length,
		publishedAt: entry.ts,
		touchedAt: touch.touchedAt,
		...(found && { diagnostics: entry.diags }),
	};
}

/**
 * The delivery every late answer takes, whichever read found it: a
 * `resolved-found` re-injects through `onResolvedFound` (#1023) under the
 * session's write guard (#3499), a `resolved-clean` clears the footer and the
 * pending record through `onResolvedClean` (#1444). Best-effort: a throwing
 * callback must not drop the caller's record or the sibling deliveries.
 */
function deliverResolvedOutcome(
	o: ReconcileOutcome,
	guard: DeliveryGuard | undefined,
): void {
	try {
		if (o.outcome === "resolved-found" && o.diagnostics?.length) {
			const neighbor: ResolvedFoundNeighbor = {
				filePath: o.filePath,
				serverId: o.serverId,
				diagnostics: o.diagnostics,
				...(o.publishedAt !== undefined ? { publishedAt: o.publishedAt } : {}),
				...(o.touchedAt !== undefined ? { touchedAt: o.touchedAt } : {}),
			};
			const deliver = () => _reconcileOptions.onResolvedFound?.(neighbor);
			if (guard) guard.guardedWrite(o.filePath, deliver);
			else deliver();
		} else if (o.outcome === "resolved-clean" && o.publishedAt != null) {
			_reconcileOptions.onResolvedClean?.({
				filePath: o.filePath,
				serverId: o.serverId,
				publishedAt: o.publishedAt,
			});
		}
	} catch {
		// best-effort surfacing; the caller's row is the durable record.
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
	const evicted = _outstandingTouches.set(key, entry);
	for (let i = 0; i < evicted.length; i++) {
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
	const dropped = _outstandingTouches.size;
	_outstandingTouches.clear();
	_expiredSinceLastSweep = 0;
	_evictedSinceLastSweep = 0;
	// #4485: one row per reset, only when something went unanswered.
	if (dropped > 0) {
		logCascade({
			phase: "cascade_tier3_dropped",
			filePath: "<session-reset>",
			metadata: { count: dropped },
		});
	}
}

/** Test-only: clear the outstanding-touch registry between test cases,
 * without the reset's dropped row. */
export function _resetOutstandingCascadeTouchesForTests(): void {
	_outstandingTouches.clear();
	_expiredSinceLastSweep = 0;
	_evictedSinceLastSweep = 0;
}

/**
 * #4485: turn_end's one read of the registry, after its cascade settle and
 * before it consumes the turn's runs. Each answered touch is removed and
 * delivered (a found one appends its run in time for this turn_end); a
 * silent one stays for the quiet window. Synchronous: it reads each touch's
 * own client (`OutstandingTouch.client`) and never spawns or awaits one.
 * One `cascade_tier3_peek` row when the registry held anything.
 */
export function peekOutstandingCascadeTouches(guard?: DeliveryGuard): void {
	const now = Date.now();
	const reads: ClientReads = new Map();
	pruneExpiredOutstandingTouches(now, guard, reads);
	const count = _outstandingTouches.size;
	if (count === 0) return;
	let found = 0;
	let clean = 0;
	for (const [key, touch] of _outstandingTouches) {
		const outcome = readTouchedClient(touch, now, reads);
		if (!outcome) continue;
		_outstandingTouches.delete(key);
		if (outcome.outcome === "resolved-found") found++;
		else clean++;
		deliverResolvedOutcome(outcome, guard);
	}
	logCascade({
		phase: "cascade_tier3_peek",
		filePath: "<turn_end>",
		metadata: {
			count,
			found,
			clean,
			outstanding: _outstandingTouches.size,
		},
	});
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
	/**
	 * #4495 round 3: the touch's pre-notify stamp, the earliest moment the
	 * answered content could have been read. Set with `publishedAt`.
	 */
	touchedAt?: number;
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
	/** Where an expiring entry's answer is delivered (the quiet-window task's
	 * session guard). */
	guard?: DeliveryGuard,
): Promise<ReconcileOutcome[]> {
	const outcomes: ReconcileOutcome[] = [];
	// #1899: the age bound applies at sweep time too, not only at record time —
	// a registry that received no further touches would otherwise hand the sweep
	// entries of unbounded age.
	pruneExpiredOutstandingTouches(Date.now(), guard);
	const entries = _outstandingTouches.entriesArray();
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
				touchedAt: touch.touchedAt,
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
/** #4485: the delivery callbacks, kept so every read (the quiet window,
 * turn_end's peek, the expiry read) delivers through the same wiring. */
let _reconcileOptions: CascadeTierReconcileOptions = {};

/** #1023: a `resolved-found` neighbor error to re-inject into agent-facing output. */
export interface ResolvedFoundNeighbor {
	filePath: string;
	serverId: string;
	diagnostics: LSPDiagnostic[];
	/** #3168 F3: the #1444 publish stamp, threaded so a run built from this
	 * neighbor carries its own observation time — the carried-run age label
	 * renders from it instead of claiming no stamp exists. */
	publishedAt?: number;
	/** #4495 round 3: the touch's pre-notify stamp, the run's read bound. */
	touchedAt?: number;
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
	_reconcileOptions = options;

	registerQuietWindowTask("cascade_tier3_reconcile", async (context) => {
		if (!isTierAwareCascadeEnabled()) return;
		// #3499: `context.sessionGeneration` was captured when this task started,
		// with no await before the synchronous drain below, so it is the
		// generation of the touches drained. The re-injection appends to the
		// runtime shared with a same-cwd replacement; it is dropped if the
		// task's session is gone.
		const guard = context?.sessionGeneration;
		const outcomes = await reconcileOutstandingCascadeTouches(
			getLspService(),
			guard,
		);

		// #1023: re-inject each resolved-found neighbor error so it reaches the
		// agent (previously logs-only). #1444: hand each resolved-CLEAN outcome to
		// the footer reconcile for the mirror-image case: the neighbour proved
		// clean only after the in-lane wait, so nothing has cleared its earlier
		// error entries.
		for (const o of outcomes) deliverResolvedOutcome(o, guard);

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
	_reconcileOptions = {};
}
