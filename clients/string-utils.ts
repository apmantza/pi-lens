/**
 * Ordinal (code-unit) string comparator for identity-feeding sorts — cache
 * keys, dedupe keys, hashes, and signatures. Refs #2155, #2165.
 *
 * `localeCompare` orders strings by locale-dependent collation (the DEFAULT
 * `Array.prototype.sort`, with no comparator, does not — it compares UTF-16
 * code units, which is already ordinal). Locale-dependent order is fine for
 * a list a human reads. It is a bug (SonarCloud S2871) when the sorted
 * result feeds an identity: two processes — or one process whose locale
 * changes — can order the same input differently under `localeCompare` and
 * mint different keys for equivalent state, producing a silent cache or
 * dedupe miss.
 *
 * Use this comparator whenever a sort's output becomes a key, a hash input,
 * or a signature compared for equality later. Keep `localeCompare` for
 * sorting that only affects what a person reads.
 */
export function compareOrdinal(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Escape a string for safe interpolation into a `RegExp` source, so every
 * regex metacharacter it contains is matched literally instead of taking on
 * its regex meaning. This is the ONE runtime copy (#2558) — string-utils.ts
 * is a leaf (no imports of its own), so importing it never creates a cycle.
 * Before #2558 this same body was hand-copied under this name (and as
 * `escapeRegExpChar`/`escapeRegExpLiteral`) into ~8 production modules and 3
 * test helpers; fold new call sites onto this export instead of re-copying
 * it.
 */
export function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
