/**
 * #2001/#2002 — collect-later coverage store for slow auxiliary LSP servers.
 *
 * When a `with-auxiliary` touch's aux-grace window expires without a
 * publication from an auxiliary scanner (opengrep on Windows measures ~8s per
 * scan against a 2s grace), that scanner's eventual findings were silently
 * cached inside its LSP client and never surfaced to the agent: the auxiliary
 * contributed ZERO agent-visible coverage on most edits.
 *
 * This module is the bounded hand-off between the two halves of the fix:
 *
 *   - PRODUCER (`clients/lsp/index.ts`'s aux-grace wait): after the outcomes
 *     are decided, every auxiliary with no publication evidence for this
 *     content (`cut_off` or `silent`, minus #1493's published-this-content
 *     exemption) marks its (filePath, serverId) pair here. DEFERRED servers
 *     are never marked — they never received the content, so their cache
 *     still describes the PREVIOUS revision (#1459).
 *   - CONSUMER (`clients/runtime-turn.ts` at turn_end): drains the store,
 *     probes each pair through the read-only
 *     `LSPService.readCachedDiagnosticsForServers` seam, freshness-gates the
 *     result against `markedAtMs`, and delivers survivors as the registered
 *     `runtime-turn:late-auxiliary-findings` gated surface. A pair whose
 *     client is alive but has STILL published nothing is re-armed until
 *     readLateAuxRearmTtlMs() (env-overridable via
 *     `PI_LENS_LATE_AUX_REARM_TTL_MS`) after the LAST re-arm, so a scan
 *     finishing between two turn ends is not lost and a demonstrably alive
 *     but slow scanner keeps its window open; `markedAtMs` itself never
 *     moves — it stays the immutable freshness baseline the delivery gate
 *     stats against. Past the TTL, or when the client is gone, the entry is
 *     dropped silently (best-effort by design).
 *
 * Bounds: at most MAX_PENDING_ENTRIES (file, server) pairs, insertion-order
 * eviction of the OLDEST pair when the cap is exceeded (shape 9 discipline —
 * the axis that grows is the pair count, so that is the axis that is capped).
 * Keys fold through `normalizeEphemeralMapKey`: this is a hot single-process
 * index whose keys are produced by this same process's touch path, so the
 * cheap ephemeral normalizer is the lifetime-appropriate choice per the
 * PathKeyedMap guidance — no realpath walk on the per-edit path.
 *
 * #2324 F3/R2-A: this module ALSO hands off in the other direction, for
 * ast-grep specifically. Gate B's napi runner is a second producer of
 * coverage for the same (file, "ast-grep") pair — when it runs as the
 * fallback and actually evaluates rules, it calls
 * {@link recordNapiFallbackCoverage}. The PRODUCER above reads that record
 * (via {@link napiFallbackCoveredSince}) before deciding whether to mark a
 * pair, because napi's Gate-B check settles synchronously while the aux-grace
 * wait's own decision takes up to its full grace budget — by the time the
 * wait is ready to mark, THIS touch's napi run (if any) has already finished,
 * so the wait can reliably see it; a clear issued from napi's side cannot,
 * because the mark it would be racing has not been written yet.
 * {@link clearPendingAuxiliaryCoverage} is still used, but only to drop a
 * LEFTOVER pair from an EARLIER touch once napi has fresh evaluated findings
 * to supersede it.
 */

import { BoundedFifoMap } from "../bounded-cache.js";
import { normalizeEphemeralMapKey } from "../path-utils.js";

/** Maximum pending (filePath, serverId) pairs; oldest evicted beyond this. */
export const MAX_PENDING_AUX_ENTRIES = 50;

/**
 * Default for how long a marked pair keeps being re-probed at successive
 * turn ends when the client is alive but has published nothing yet. Covers
 * opengrep's measured ~8s worst case many times over without pinning state
 * forever. Overridable via `PI_LENS_LATE_AUX_REARM_TTL_MS`.
 */
export const DEFAULT_LATE_AUX_REARM_TTL_MS = 5 * 60_000;
export const MAX_LATE_AUX_REARMS = 8;

/**
 * Read the `PI_LENS_LATE_AUX_REARM_TTL_MS` env override at call time (not
 * module load time) so tests and users can tune without a rebuild — same
 * shape as `readEnvAuxGraceMs` in clients/lsp/index.ts. Absent, non-numeric,
 * or negative values fall back to {@link DEFAULT_LATE_AUX_REARM_TTL_MS}.
 */
export function readLateAuxRearmTtlMs(): number {
	const raw = process.env.PI_LENS_LATE_AUX_REARM_TTL_MS;
	if (raw === undefined) return DEFAULT_LATE_AUX_REARM_TTL_MS;
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed) || parsed < 0)
		return DEFAULT_LATE_AUX_REARM_TTL_MS;
	return parsed;
}

export interface PendingAuxCoverageEntry {
	/** Original-spelling file path (display form; keys are normalized internally). */
	filePath: string;
	serverId: string;
	/**
	 * Freshness baseline: when this pair was FIRST marked, i.e. roughly when
	 * the touch's notify went out. The turn-end gate stats the file against
	 * this timestamp; re-arming preserves it so the baseline never drifts
	 * forward past the content the pending findings describe. Only a NEWER
	 * touch (a producer re-mark for a newer revision) advances it (#2027).
	 */
	markedAtMs: number;
	/** SHA-256 of the touch content this late publication must describe. */
	contentHash?: string;
	/**
	 * When the most recent turn-end probe re-armed this pair, if it did.
	 * The re-arm TTL measures from THIS clock, not from `markedAtMs`: every
	 * successful empty probe proves the scanner is alive (just slow), so it
	 * extends the window instead of letting the original mark's TTL retire a
	 * still-working pair. Undefined until the first re-arm, so an untouched
	 * pair's TTL still measures from its mark. Kept deliberately separate
	 * from `markedAtMs` so extending the wait can never weaken the delivery
	 * gate's freshness comparison.
	 */
	lastRearmedAtMs?: number;
	rearmCount?: number;
}

/**
 * Whether a pending pair is past its re-arm TTL and should be retired at the
 * next drain. The TTL anchors on {@link PendingAuxCoverageEntry.lastRearmedAtMs}
 * when present (each successful probe extends the window), else on
 * `markedAtMs`. `nowMs` is injectable so tests are deterministic.
 */
export function isPendingAuxiliaryPastRearmTtl(
	pair: PendingAuxCoverageEntry,
	nowMs: number = Date.now(),
): boolean {
	const anchor = pair.lastRearmedAtMs ?? pair.markedAtMs;
	return nowMs - anchor >= readLateAuxRearmTtlMs();
}

const pending = new BoundedFifoMap<string, PendingAuxCoverageEntry>(
	MAX_PENDING_AUX_ENTRIES,
);

/**
 * #2168: pairs evicted at the cap have no other retirement record — the
 * drain-time reconciliation in `runtime-turn.ts` never sees them because
 * they are gone before a drain can observe them. Counted here so the
 * consumer can fold them into its per-turn `pairCreated`/retirement sum
 * instead of the pair vanishing uncounted.
 */
let capEvictedCount = 0;

function pairKey(filePath: string, serverId: string): string {
	return `${normalizeEphemeralMapKey(filePath)}\u0000${serverId}`;
}

/**
 * Mark (or re-arm) one file's pending auxiliary coverage for `serverIds`.
 * An existing pair keeps its ORIGINAL `markedAtMs`; only genuinely new pairs
 * stamp the current time. Insertion order updates on re-mark so a re-armed
 * pair is not the next one evicted at the cap.
 *
 * `rearmedAtMs` is the turn-end consumer's re-arm form: it stamps
 * `lastRearmedAtMs` (the TTL anchor) WITHOUT moving the freshness baseline,
 * so each successful probe extends the wait window while the delivery gate
 * keeps comparing mtimes against the original mark. The producer form (no
 * `rearmedAtMs`) marks a NEWER revision, so it resets any prior re-arm stamp
 * along with the baseline — the new pair's TTL starts from its own mark.
 */
export function markPendingAuxiliaryCoverage(
	filePath: string,
	serverIds: readonly string[],
	markedAtMs: number = Date.now(),
	rearmedAtMs?: number,
	rearmCount?: number,
	contentHash?: string,
): void {
	for (const serverId of serverIds) {
		const key = pairKey(filePath, serverId);
		const existing = pending.get(key);
		if (existing) {
			// #2027 review: bump the freshness baseline on producer re-mark. A
			// newer touch means the auxiliary is scanning a NEWER revision;
			// keeping the original baseline would make every post-baseline mtime
			// read as stale, permanently dropping current-revision findings.
			// A re-arm form never moves the baseline — only the TTL anchor.
			pending.delete(key);
			pending.set(
				key,
				rearmedAtMs === undefined
					? { filePath, serverId, markedAtMs, contentHash }
					: {
							filePath,
							serverId,
							markedAtMs: existing.markedAtMs,
							contentHash: existing.contentHash,
							lastRearmedAtMs: rearmedAtMs,
							rearmCount: rearmCount ?? (existing.rearmCount ?? 0) + 1,
						},
			);
			continue;
		}
		const evicted = pending.set(
			key,
			rearmedAtMs === undefined
				? { filePath, serverId, markedAtMs, contentHash }
				: {
						filePath,
						serverId,
						markedAtMs,
						contentHash,
						lastRearmedAtMs: rearmedAtMs,
						rearmCount: rearmCount ?? 1,
					},
		);
		capEvictedCount += evicted.length;
	}
}

/** Re-arm a drained pair while carrying its ceiling count across the drain. */
export function rearmPendingAuxiliaryCoverage(
	pair: PendingAuxCoverageEntry,
	rearmedAtMs: number = Date.now(),
	refreshBaseline = false,
): void {
	const nextCount = (pair.rearmCount ?? 0) + 1;
	markPendingAuxiliaryCoverage(
		pair.filePath,
		[pair.serverId],
		refreshBaseline ? rearmedAtMs : pair.markedAtMs,
		rearmedAtMs,
		nextCount,
		pair.contentHash,
	);
}

/**
 * Read-only check: is this (file, server) pair currently pending late
 * delivery? #2324 F2: Gate B's "has this server EVER published for this
 * file" answer goes stale the moment a later touch's aux-grace wait finds
 * the server silent for the CURRENT content — a pending pair is exactly
 * that signal, so a caller deciding whether to skip a fallback runner can
 * tell "published, still current" from "published once, silent now" without
 * draining or mutating the store.
 */
export function hasPendingAuxiliaryCoverage(
	filePath: string,
	serverId: string,
): boolean {
	return pending.has(pairKey(filePath, serverId));
}

/**
 * Remove one pair after its findings were delivered, or whenever the caller
 * knows it is resolved. Unknown pairs are a no-op.
 */
export function clearPendingAuxiliaryCoverage(
	filePath: string,
	serverId: string,
): void {
	pending.delete(pairKey(filePath, serverId));
}

/**
 * Drain ALL pending pairs (removing them from the store) and return them in
 * insertion order. The consumer re-arms the still-waiting subset via
 * {@link markPendingAuxiliaryCoverage}'s `rearmedAtMs` form, which preserves
 * each entry's original `markedAtMs` and stamps `lastRearmedAtMs`.
 */
export function drainPendingAuxiliaryCoverage(): PendingAuxCoverageEntry[] {
	const drained = [...pending.values()];
	pending.clear();
	return drained;
}

/** Current pending pair count for bounded reconciliation telemetry. */
export function pendingAuxiliaryCoverageSize(): number {
	return pending.size;
}

/**
 * Drain (read and reset) the cap-eviction count accumulated since the last
 * drain. Mirrors {@link drainPendingAuxiliaryCoverage}'s consume-once shape
 * so the turn-end consumer can fold evictions that happened between two
 * turn ends into its reconciliation sum exactly once, never accumulating
 * across turns.
 */
export function drainPendingAuxCapEvictedCount(): number {
	const count = capEvictedCount;
	capEvictedCount = 0;
	return count;
}

/**
 * #2324 R2-A: (file) -> the timestamp of the LAST time the ast-grep napi
 * fallback actually evaluated rules for it, as Gate B's runner
 * (`clients/dispatch/runners/ast-grep-napi.ts`). This is the cross-module
 * hand-off the aux-grace wait (`clients/lsp/index.ts`) needs to avoid
 * marking a pending late-auxiliary pair for a file napi ALREADY delivered
 * for on THIS touch.
 *
 * Ordering is why a synchronous clear-on-napi-run cannot do this job: the
 * wait that decides whether to mark a pair runs for up to ~1800ms (its own
 * grace budget) AFTER napi's Gate-B check, which is a single map lookup.
 * Clearing at napi's run start (or end) races the mark and reliably loses —
 * the mark, if any, has not been written yet. The wait itself is the only
 * place that knows the outcome, so it is the one that must consult this
 * store and skip marking, not the runner that must guess at the wait's
 * future decision.
 *
 * Bounded like the pending-pair store itself; oldest evicted first.
 */
export const MAX_NAPI_COVERAGE_ENTRIES = 50;
const napiFallbackCoverage = new BoundedFifoMap<string, number>(
	MAX_NAPI_COVERAGE_ENTRIES,
);

/** Record that napi actually evaluated rules for `filePath` at `atMs`. */
export function recordNapiFallbackCoverage(
	filePath: string,
	atMs: number = Date.now(),
): void {
	const key = normalizeEphemeralMapKey(filePath);
	napiFallbackCoverage.delete(key);
	napiFallbackCoverage.set(key, atMs);
}

/**
 * Did napi cover `filePath` at or after `sinceMs`? The aux-grace wait passes
 * its own `waitStartedAt` baseline so a STALE coverage record from an
 * earlier touch (napi ran for a PREVIOUS revision) cannot suppress marking a
 * pair this touch's silent server genuinely needs delivered later.
 */
export function napiFallbackCoveredSince(
	filePath: string,
	sinceMs: number,
): boolean {
	const ts = napiFallbackCoverage.get(normalizeEphemeralMapKey(filePath));
	return ts !== undefined && ts >= sinceMs;
}

/** Test-only reset for the napi-coverage hand-off. */
export function resetNapiFallbackCoverageForTests(): void {
	napiFallbackCoverage.clear();
}

/**
 * Session-boundary clear (#1635): pending baselines are unreachable after
 * reset (the generation-stamped keys no longer match any active session).
 */
export function resetPendingAuxiliaryCoverage(): void {
	pending.clear();
	capEvictedCount = 0;
	napiFallbackCoverage.clear();
}
