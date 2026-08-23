/**
 * Freshness kernel (#1739): ONE comparator and ONE verdict type for every
 * "was this file modified after my reference timestamp?" gate.
 *
 * The same staleness comparison was independently reimplemented in at least
 * six stores (advisory-provenance, blocker-freshness,
 * project-diagnostics/cache [#1711], widget-state ×3, lsp/workspace-
 * diagnostics-cache), and three of those copies carried the identical
 * mtime-tolerance defect fixed separately in #1710/#1711/#1664. This module
 * is the single implementation going forward; the registered-or-fail sweep
 * (`tests/clients/freshness-sweep.test.ts`) fails on new out-of-kernel
 * comparisons so the population cannot silently regrow.
 *
 * Deliberately NOT here: age-based checks (`Date.now() - mtime > TTL` — that
 * is expiry, not freshness against a reference event) and max-selection
 * comparisons (`mtime > best.mtimeMs`) — neither compares against a scan or
 * record timestamp, which is what this kernel's verdict means.
 */

/** Shared drift tolerance: raised from 0 to 50ms after measured Windows mtime skew produced 42 false demotions in 50 runs (#1710 evidence). */
export const MTIME_DRIFT_TOLERANCE_MS = 50;

export type FreshnessVerdict =
	| { verdict: "fresh" }
	| {
			verdict: "stale";
			reason: "modified-after-reference";
	  }
	| {
			verdict: "indeterminate";
			reason: "no-mtime-evidence";
	  };

/**
 * Compare an observed mtime against a reference timestamp (the scan, record,
 * or touch instant whose validity depends on the file not having moved).
 *
 * `mtimeMs === undefined` means the caller had no readable mtime (stat
 * failed, file gone). The kernel does NOT choose a policy for that case -
 * callers differ legitimately (a diagnostics cache drops, a drift detector
 * skips) - so it reports `indeterminate` and the caller maps it.
 */
export function freshnessFromMtime(input: {
	mtimeMs: number | undefined;
	referenceMs: number;
	toleranceMs?: number;
}): FreshnessVerdict {
	const tolerance = input.toleranceMs ?? MTIME_DRIFT_TOLERANCE_MS;
	if (input.mtimeMs === undefined) {
		return { verdict: "indeterminate", reason: "no-mtime-evidence" };
	}
	return input.mtimeMs > input.referenceMs + tolerance
		? { verdict: "stale", reason: "modified-after-reference" }
		: { verdict: "fresh" };
}
