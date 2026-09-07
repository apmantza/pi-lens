/**
 * The degradation ledger's field-truncation policy, as a leaf module (#1816).
 *
 * It lives here rather than in `degradation-ledger.ts` because reason BUILDERS
 * (`formatToolFailure`, `firstOutputLine`) need the bound without importing the
 * ledger itself. Test files routinely `vi.mock` the ledger to observe recorded
 * degradations; a builder that reached through that mock for a constant would
 * break every one of them.
 */

/** The single truncation bound for every ledger field, and for the reasons callers build. */
export const LEDGER_FIELD_MAX = 200;

/**
 * How many retained entries the ledger keeps per kind — and therefore the bound
 * any producer of ledger-bound records sizes itself to.
 *
 * Moved here from `degradation-ledger.ts` (#2426) for the reason this module's
 * doc comment already gives: `config-core/records.ts` bounds its collector to
 * this number, and reading it off the LEDGER made the config core import a sink
 * it is documented not to touch ("Pure: no state, no I/O, no ledger writes").
 * That import also broke three suites that `vi.mock` the ledger wholesale — the
 * exact failure mode this leaf exists to prevent — and closed seven import
 * cycles once the config loaders started resolving through the core.
 */
export const DEGRADATION_ENTRIES_PER_KIND = 20;

export function normalizeForLedger(value: unknown): string {
	if (value === null || value === undefined) return "unknown";
	// A plain object or array has no `toString` of its own, so `String()`
	// writes "[object Object]" — a ledger row that names nothing. Serialise
	// those; everything else (Error, Date, URL, primitives, class instances)
	// keeps its `String()` form. An object carrying its OWN `toString` goes
	// through `String()` too, so a throwing one still raises into the
	// ledger's corrupted-input failsafe (#2703 r1 F1) instead of being
	// admitted as "{}". Circular input degrades to a fixed marker.
	if (typeof value === "object" && !Object.hasOwn(value, "toString")) {
		const proto = Object.getPrototypeOf(value);
		if (proto === Object.prototype || proto === null || Array.isArray(value)) {
			try {
				return JSON.stringify(value) ?? "unknown";
			} catch {
				return "[unserializable object]";
			}
		}
	}
	return String(value);
}

/** Bound a value to `LEDGER_FIELD_MAX`, marking the elision. */
export function truncateForLedger(value: unknown): string {
	const text = normalizeForLedger(value);
	return text.length > LEDGER_FIELD_MAX
		? `${text.slice(0, LEDGER_FIELD_MAX)}…`
		: text;
}
