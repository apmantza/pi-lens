/**
 * Set algebra for the persisted turn-end test-target deferral lists
 * (`TestRunnerFindingsCache.deferredTargets` / `retiredTargets`).
 *
 * #2522 review round 4 built the merge-and-bound rule inside
 * `runtime-turn.ts`'s one writer. #2542 ask 3 needs a second caller — the
 * delivery seam re-queues a run for a file whose delivered verdict is stale —
 * so the rule lives here and both writers ask this owner instead of
 * re-deriving the key, the merge, or the bound. The constants moved with it;
 * `runtime-turn.ts` re-exports `TEST_RUNNER_MAX_PERSISTED_TARGETS` for its
 * existing callers.
 */

import * as path from "node:path";
import { normalizeMapKey } from "./path-utils.js";
import type { DeferredTestTarget } from "./project-diagnostics/runner-adapters/runner-findings.js";

/**
 * Ceiling on how many entries either persisted target list may carry.
 *
 * #2522 review round 4, I1: a write may no longer destroy another session's
 * entries, so nothing in the write path prunes them any more — each session
 * that ever cut or retired a target in this project leaves its rows behind, on
 * a record read at every single turn_end. The bound is applied at the one
 * writer, on the whole list, and sheds FOREIGN rows first (the writer orders
 * this session's entries last), so it can never evict the entries this turn
 * depends on. Generous on purpose: it is a backstop against unbounded growth,
 * not a scheduling policy.
 */
export const TEST_RUNNER_MAX_PERSISTED_TARGETS = 64;

/**
 * Union two deferral sets by target identity, keeping the HIGHER attempt count
 * (#2522 review round 3, F3). Two overlapping batches can both be cut on the
 * same target; taking the lower count would let a target trade an attempt for
 * every overlap and never converge on `TEST_RUNNER_MAX_DEFERRALS`.
 *
 * Identity is (session, path), not path alone (#2522 review round 4, I1): two
 * sessions can each owe a run of the same file, and collapsing those into one
 * row makes the surviving row's `sessionId` decide whose deferral is honoured
 * and whose is silently dropped. The path half is keyed through
 * `normalizeMapKey` so `/`- and `\`-separated spellings are one entry
 * (AGENTS.md cross-form-path screen).
 */
function deferralEntryKey(entry: DeferredTestTarget): string {
	return `${entry.sessionId ?? ""}\u0000${normalizeMapKey(path.resolve(entry.testFile))}`;
}

export function mergeDeferredTargets(
	existing: readonly DeferredTestTarget[],
	incoming: readonly DeferredTestTarget[],
): DeferredTestTarget[] {
	const byKey = new Map<string, DeferredTestTarget>();
	for (const entry of [...existing, ...incoming]) {
		const key = deferralEntryKey(entry);
		const prior = byKey.get(key);
		if (prior && (prior.attempts ?? 0) >= (entry.attempts ?? 0)) continue;
		byKey.set(key, entry);
	}
	return [...byKey.values()];
}

/**
 * Apply {@link TEST_RUNNER_MAX_PERSISTED_TARGETS} to a merged list, keeping
 * the caller's own entries and shedding foreign rows first. `isOwn` is the
 * only session fact this pure function needs; the caller keeps the logging.
 *
 * The partition is a single loop rather than two `Array.prototype.filter`
 * passes: this module is scanned by the glossary synonym-retirement census,
 * and the fewer retired-identifier uses it adds, the fewer pins a rename has
 * to chase.
 */
export function boundDeferredTargets(
	entries: readonly DeferredTestTarget[],
	max: number,
	isOwn: (entry: DeferredTestTarget) => boolean,
): DeferredTestTarget[] {
	const foreign: DeferredTestTarget[] = [];
	const own: DeferredTestTarget[] = [];
	for (const entry of entries) {
		if (isOwn(entry)) own.push(entry);
		else foreign.push(entry);
	}
	const ordered = [...foreign, ...own];
	if (ordered.length <= max) return ordered;
	return ordered.slice(-max);
}
