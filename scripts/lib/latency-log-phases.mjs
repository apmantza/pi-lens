// Pure NDJSON latency-log phase parsing for scripts/compat-smoke-behavioral.mjs
// (#476, Layer B).
//
// `clients/latency-logger.ts` writes one JSON object per line to
// `~/.pi-lens/latency.log` (see `createNdjsonLogger`). Layer B launches real
// `pi` processes and needs to assert (or assert the ABSENCE of) specific
// `type: "phase"` entries that landed during a bounded time window — this
// module is the pure parsing/filtering half, kept separate from the
// file-reading/process-spawning orchestration so it is unit-testable without
// touching the filesystem or spawning anything.

/**
 * Parse NDJSON text into an array of entries. Malformed lines (partial write,
 * truncation mid-append) are skipped rather than throwing — the log is
 * best-effort by construction (ndjson-logger.ts swallows write errors), so a
 * single bad line must never abort the whole read.
 *
 * @param {string} text raw latency.log contents
 * @returns {Array<Record<string, unknown>>}
 */
export function parseNdjsonEntries(text) {
	const entries = [];
	for (const line of text.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			const parsed = JSON.parse(trimmed);
			if (parsed && typeof parsed === "object") entries.push(parsed);
		} catch {
			// partial/corrupt line — skip
		}
	}
	return entries;
}

/**
 * Filter entries to `type: "phase"` records with the given `phase` name,
 * optionally restricted to entries whose `ts` (ISO timestamp) falls at or
 * after `sinceIso`. Used to scope a check to "phases logged by THIS run" when
 * the log file is long-lived and shared across sessions.
 *
 * @param {Array<Record<string, unknown>>} entries
 * @param {string} phase
 * @param {string} [sinceIso] ISO timestamp lower bound (inclusive)
 */
export function findPhaseEntries(entries, phase, sinceIso) {
	const sinceMs = sinceIso ? Date.parse(sinceIso) : undefined;
	return entries.filter((e) => {
		if (e.type !== "phase" || e.phase !== phase) return false;
		if (sinceMs === undefined) return true;
		const ts = typeof e.ts === "string" ? Date.parse(e.ts) : Number.NaN;
		return Number.isFinite(ts) && ts >= sinceMs;
	});
}

/**
 * True iff at least one `findPhaseEntries` match exists.
 *
 * @param {Array<Record<string, unknown>>} entries
 * @param {string} phase
 * @param {string} [sinceIso]
 */
export function phaseWasLogged(entries, phase, sinceIso) {
	return findPhaseEntries(entries, phase, sinceIso).length > 0;
}

/**
 * True iff NO phase in `phases` was logged since `sinceIso` — used to assert
 * a degraded/skip path did NOT engage (e.g. heavyweight scans must be absent
 * under subagent light mode).
 *
 * @param {Array<Record<string, unknown>>} entries
 * @param {string[]} phases
 * @param {string} [sinceIso]
 */
export function noPhasesLogged(entries, phases, sinceIso) {
	return phases.every((phase) => !phaseWasLogged(entries, phase, sinceIso));
}

/**
 * Number of entries (any type) whose `ts` falls at or after `sinceIso`.
 * Positive control for the absence assertions: "no heavyweight phase logged"
 * is only evidence when the run wrote SOMETHING to the log the smoke is
 * reading — an empty or mis-located log made those pass vacuously (#2570).
 *
 * @param {Array<Record<string, unknown>>} entries
 * @param {string} sinceIso ISO timestamp lower bound (inclusive)
 */
export function countEntriesSince(entries, sinceIso) {
	const sinceMs = Date.parse(sinceIso);
	return entries.filter((e) => {
		const ts = typeof e.ts === "string" ? Date.parse(e.ts) : Number.NaN;
		return Number.isFinite(ts) && ts >= sinceMs;
	}).length;
}

/**
 * The p-quantile of an ascending sample by the clamped floor-rank index
 * `clamp(floor(p * n), 0, n - 1)`, so `p(0)` answers the first element, `p(1)`
 * the last, and every reported number is an OBSERVED sample rather than an
 * interpolation between two.
 *
 * The exact rule matters at small n, so it is named rather than labelled
 * "nearest-rank": at even n the p50 is the UPPER of the two middle samples
 * (`n = 2` → the 2nd, `n = 20` → the 11th, where nearest-rank answers the 10th),
 * and for every `n <= 20` the p95 index `floor(0.95 * n)` is the last index, so
 * a 20-row group reports p95 equal to max and shows no tail of its own.
 *
 * This is the ONE implementation for both consumers of a latency-log percentile:
 * the published log analyzer (`scripts/analyze-pi-lens-logs.mjs`, #5263) and the
 * hot-path gate's bootstrapped CI tails (`scripts/lib/latency-stats.mjs`, #4363).
 * It lives here because this module is the only percentile home in `package.json`
 * `files`: `latency-stats.mjs` is dev/CI-only, so having the analyzer import it
 * shipped `scripts/analyze-pi-lens-logs.mjs -> './lib/latency-stats.mjs'` →
 * `NOT FOUND` in the packed tree (the `Install test` leg runs
 * `scripts/check-extensions.mjs` over the installed files). The two percentile
 * siblings that stay separate are different methods on purpose:
 * `clients/performance-report.ts` interpolates between samples for its
 * in-session p50/p99 summary, and `scripts/bench-word-index-replacement.mjs`
 * uses `floor((n - 1) * p)`; folding either would change shipped numbers.
 *
 * @param {readonly number[]} sorted ascending sample
 * @param {number} p quantile in [0, 1]
 */
export function lowerRankPercentile(sorted, p) {
	const at = Math.min(
		sorted.length - 1,
		Math.max(0, Math.floor(p * sorted.length)),
	);
	return sorted[at];
}
