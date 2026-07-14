/**
 * Collision-safe review-graph symbol-node ID (refs #655 — narrow first slice).
 *
 * The pre-existing scheme (`${file}:${name}`) collapses distinct symbols that
 * share a name into ONE graph node: overloaded functions/methods, same-named
 * methods on different classes, and same-named nested functions all produce
 * the identical ID. That node backs `pilens_module_report`'s `usedBy` and
 * `blastRadius` sections today, so those two genuinely different symbols'
 * caller/reference edges silently merge onto one node.
 *
 * This adds the symbol's declaration KIND and start LINE — enough to give
 * every one of those concrete collision cases a distinct ID, since they are
 * always on different lines.
 *
 * Deliberately scoped DOWN from #655's full proposed shape
 * (`<file>:<qualified-name>:<kind>:<start-line>:<start-column>`):
 *
 * - No qualified ownership (e.g. `ClassName.method`). Full qualified-name
 *   tracking needs an owner-chain (class/namespace) computed uniformly across
 *   every tree-sitter grammar the graph ingests — real work, not needed to
 *   fix the concrete bug. Kind + line already disambiguates every case in
 *   scope without it; #655 leaves qualified ownership as later, broader work.
 * - No start COLUMN. Review-graph symbols for JS/TS come from a DIFFERENT
 *   extractor (`dispatch/facts/function-facts.ts`, keyed off the function-like
 *   node's own start) than module-report's own outline symbols
 *   (`tree-sitter-symbol-extractor.ts`, keyed off the declaration node's
 *   start). The two agree on start LINE for every function-like declaration
 *   but can diverge by a few columns for arrow functions — e.g.
 *   `const foo = () => {}`: function-facts measures from the `(` param list,
 *   the symbol extractor measures from the `foo` identifier. Keying on line
 *   only keeps IDs built by either extractor comparable; every collision case
 *   this slice targets (overloads, sibling-class methods, nested functions)
 *   already sits on a distinct line, so dropping column loses no precision
 *   this bug needs.
 *
 * Known residual gap: an arrow assigned across a line break (`const foo =\n
 * () => {}`) can still put function-facts' start row (the `(`) one line after
 * the symbol extractor's start row (`foo`). Rare in real code and fails SAFE —
 * module-report simply finds no graph node for that one symbol (falls back to
 * its existing "no usedBy data" path) rather than merging it with anything
 * else. Not worth a same-line-normalizing special case for this narrow slice.
 *
 * jsts callers also must not reuse `sym.kind` from module-report's own
 * tree-sitter-symbol-extractor outline unchanged: builder.ts's jsts graph
 * nodes come from a coarser extractor (function-facts.ts) that stamps every
 * function-like declaration — including class methods — as `"function"`,
 * never `"method"`. A jsts lookup must pass `"function"` regardless of the
 * outline's own finer-grained `sym.kind` (see module-report.ts's `toEntry`).
 *
 * ALL graph code that mints or looks up a real (non-placeholder) symbol node
 * ID must go through this helper — see `builder.ts` (mint) and
 * `module-report.ts` (lookup) — so the two independent extraction paths stay
 * in agreement on the ID shape.
 */
export function buildSymbolId(
	filePath: string,
	name: string,
	kind: string,
	startLine: number,
): string {
	return `${filePath}:${name}:${kind}:${startLine}`;
}
