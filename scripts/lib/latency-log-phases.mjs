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
