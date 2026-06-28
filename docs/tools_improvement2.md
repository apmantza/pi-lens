# Tool improvement proposals — round 2

These notes come from dogfooding the current registered tools on the pi-lens codebase. They focus on language-agnostic ergonomics and usefulness, not TypeScript-specific behavior.

## Guiding direction

The tools are most useful as a progressive workflow:

1. Use a compact structural overview to orient.
2. Return ranked read handles, not huge bodies by default.
3. Expand only the exact symbol, callback, or block needed.
4. Make section-level provenance explicit so agents do not over-trust heuristic or cache-backed sections.

## Review calibration

A follow-up review separated genuinely new work from things that are already shipped or redundant:

- Already shipped / do not rebuild: `module_report.focus` ranking, `recommendedReads`, `ast_grep_search` `searchReads` / `matchLocations`, and baseline cold-cache signals via `semantic.source` / `staleness`.
- Prefer existing robust handles over new ordinal syntax: `foo@line` callback/symbol handles are better than proposed `foo#2` duplicate-name ordinals because line handles do not silently shift meaning by insertion order.
- Avoid per-flag provenance objects. They would multiply JSON size and conflict with the goal of compact reports. Use section-level provenance instead.
- Treat automatic AST-pattern suggestion as deferred. `validateOnly` plus better no-match classification is the sound first step.

## `module_report`

### What works well

- Good first-pass map of a module.
- Top-level API/internal split is useful for understanding the file shape.
- Imports, who-uses-this, recommended reads, callback handles, and blast radius are valuable in combination.
- The `recommendedReads` section is the most agent-actionable part of the report.

### Weaknesses observed

- Large modules can produce too much JSON.
- Complexity/fanout flags are informative but not always directly actionable.
- Callback and risk flags are heuristic; they need visible provenance/confidence.
- Cold-cache degradation is easy to miss unless the caller inspects `semantic.source` carefully.
- A report is shape, not body; agents still need `read_symbol` / `read_enclosing` before editing.

### Proposed improvements

#### Output tiers

Add an explicit `detail` / `view` option:

- `summary`: path, language, imports count, exports, top-level symbols, recommended reads only.
- `default`: current compact report, capped sections.
- `deep`: callbacks, usedBy, blast radius, risk flags, full member lists.

Default should optimize for the next action, not exhaustive metadata.

#### Stronger filtering

Add filters that reduce output before serialization:

- `symbols: string[]`
- `kinds: string[]`
- `maxItems`
- `maxCallbacks`
- `maxUsedBy`
- `changedOnly` when diff/turn context is available

#### Recommended reads first

Consider returning `recommendedReads` near the top of the JSON and making it the primary default payload. Each recommendation should include a concise reason such as:

- exported entrypoint
- used by changed file
- contains callback
- high fanout
- matches focus terms
- blast-radius target

#### Section-level provenance

Separate hard facts from heuristics without inflating every flag. Add compact provenance at the section level, for example:

```json
{
  "provenance": {
    "symbols": "syntax",
    "usedBy": "cached-review-graph",
    "callbacks": "heuristic-tree-sitter",
    "blastRadius": "cached-review-graph"
  }
}
```

This gives most of the honesty benefit at low payload cost.

#### Cold-cache clarity

When graph-backed sections are unavailable, include a short `degraded` note naming what is missing and why. Example:

```json
{
  "degraded": ["usedBy omitted: review graph cache is cold"]
}
```

#### Fold edit planning into `recommendedReads`

Do not add a parallel `editPlan` mode. It would duplicate `recommendedReads`. Instead, make `recommendedReads` consistently carry the missing edit-plan information: read args, symbol/callback handle, reason, and source/provenance.

## `read_enclosing`

### What works well

- Excellent bridge from diagnostics/search locations to exact source.
- The `maxLines` guard prevents accidental huge reads.
- Parent chain and callback support make it better than raw line slicing.

### Weaknesses observed

- If the enclosing symbol is huge, the tool either returns too much or refuses.
- Line accuracy matters; a stale line can select the wrong scope or no scope.
- The “smallest useful” enclosing unit can still be a very large factory/function/class.
- It mostly reasons over named symbols/callbacks; useful block-level structures are not always surfaced.

### Proposed improvements

#### Oversize fallback modes

Add an option:

```text
onOversize: "error" | "slice" | "outline"
```

- `error`: current behavior.
- `slice`: return a bounded region around the target line inside the large enclosing symbol, plus the enclosing signature and parent chain.
- `outline`: return nested child blocks/callbacks/symbols within the oversized range, with read handles.

#### `aroundLine` mode

Support bounded contextual reads without pretending to read the entire enclosing symbol:

```json
{
  "line": 328,
  "aroundLine": 40,
  "includeHeader": true
}
```

The response should clearly state that it is a partial slice and include the enclosing range.

#### Generic block units

Surface language-uniform structural blocks when no smaller named symbol/callback exists:

- conditional
- loop
- try/catch/finally
- switch/match/case
- closure/lambda
- object/dictionary method/property callback

Keep the external schema generic even if internal tree-sitter node kinds differ by language.

#### Sibling navigation hints

When returning an enclosing range, include nearby siblings:

- previous symbol/block
- next symbol/block
- nearest child block containing the line

This helps agents decide whether to expand or narrow.

#### Selection provenance

Include why the tool selected that range:

```json
{
  "selection": {
    "strategy": "range-containment",
    "source": "tree-sitter",
    "confidence": "high"
  }
}
```

## `read_symbol`

### What works well

- Good exact-body read for a known symbol or callback handle.
- Pairs well with `module_report`.
- Read-guard integration makes it operationally useful, not just informational.

### Proposed improvements

- Add fuzzy suggestions when a symbol is not found: nearest names, same prefix, same kind.
- Add `includeParents: true` to include containing class/object/module headers without full parent bodies.
- Add `maxLines` and the same `onOversize` options as `read_enclosing`.
- Do not add ordinal duplicate syntax such as `symbol: "foo#2"`; prefer stable line-based handles such as `foo@120` where disambiguation is needed.

## `ast_grep_search`

### What works well

- Very useful for structural verification and targeted refactors.
- Raw YAML passthrough and structural-intent options are powerful.
- `searchReads` / match locations make follow-up edits easier.
- Good for proving that a specific construct remains or was removed.

### Weaknesses observed

- It is easy to over-specify a pattern and get false “no matches”.
- “No matches” is hard to interpret unless the pattern is known-good.
- AST grammar knowledge is still required.
- Broad patterns can produce large, noisy output.
- Selector usage can confuse agents because it narrows search roots but does not extract fields.

### Proposed improvements

#### Explain no-match confidence

On zero matches, classify the likely cause:

- valid pattern, searched files, no matches
- pattern looks too specific
- possible grammar mismatch
- selector may be over-narrowing
- language/path mismatch

Include the exact CLI/search mode used.

#### Defer automatic pattern rewriting

Automatic generation of simpler AST pattern variants is high-risk across languages and grammars. Defer it until `validateOnly` and no-match classification have proven insufficient. Static cookbook hints are safer than generated rewrites.

#### Optional pattern validation mode

Add `validateOnly: true` to parse/compile the pattern or rule without scanning files. This helps distinguish “bad pattern” from “real absence”.

#### Better result caps

Expose:

- `maxMatches`
- `maxBytes`
- `groupByFile`
- `includeCaptures: boolean`

For large results, default to grouped counts plus first few examples.

#### Pattern cookbook hints

When a user provides plain text or an incomplete pattern, return examples tailored to the broad syntactic category:

- import
- call
- function/method declaration
- assignment
- class/type declaration

These categories are language-agnostic at the tool UX level even if implementation varies by grammar.

## `ast_grep_outline`

### What works well

- Fast syntax-only second opinion.
- Useful when `module_report` is too semantic or graph-dependent.
- Good for checking exports/imports without reading entire files.

### Proposed improvements

- Add `maxItems` and `maxDepth` options.
- Add `includePrivate` / `visibility` normalization where grammars support it.
- Add a `summary` view that returns counts and top-level names only.
- Add a `constants: "omit" | "names" | "full"`-style control. Large table/object constants can dominate an otherwise useful outline.
- Keep `items: "exports"` prominent in the docs; it is much more usable than `items: "all"` on configuration-heavy modules.
- Include a clear `syntaxOnly: true` and “does not satisfy read guard” note in the main text, not only details.

## `ast_grep_dump` / `ast_dump`

### What works well

- Essential escape hatch when search patterns fail.
- Helps agents inspect node kinds and nesting.

### Proposed improvements

- Add `focus` / `line` / `range` options so dumping a large snippet can be narrowed.
- Add `namedOnly` alias for `includeAnonymous: false` for clearer UX.
- Add “suggested patterns” from selected AST nodes, e.g. turning a node into a simple `$X` pattern.

## `ast_grep_replace`

### What works well

- Dry-run default is the right safety choice.
- Structural-intent options make complex replacements more approachable.

### Proposed improvements

- Require or strongly warn when `paths` is omitted.
- Add `maxReplacements` for safety.
- Add `confirmToken` or preview hash for apply-after-preview workflows, so stale previews are less likely.
- In dry-run output, include a concise summary by file before full hunks.

## `lsp_navigation`

### What works well

- Excellent for references, hover, symbol search, and capabilities.
- Structured JSON envelope is useful.
- `searchReads` integration is valuable.

### Proposed improvements

- Add compact default output for large reference lists and document symbols, with `maxResults` across all location-returning operations.
- Add symbol-kind filters to `documentSymbol`; unfiltered output can be overwhelmed by local variables and object-property entries.
- Add `includeContainers` / `topLevelOnly` consistently across symbol-returning operations.
- Include confidence/provenance when a fallback is used.
- Make unsupported operations more actionable: “server X does not support Y; try ast_grep_search/module_report instead.”
- For `references`, distinguish “definition only” / “possibly incomplete” from a confident full reference set. A one-result response is technically correct but easy to over-trust.
- For `codeAction`, include whether diagnostics were present at the requested range; an empty result is more useful if it says “no diagnostic at range” vs “server has no quickfix.”
- For rename previews, the current summary is useful; consider adding a `filesTouched` / `editsCount` top-level summary for easier scanning.

## `lsp_diagnostics` and `lens_diagnostics`

### What works well

- `lsp_diagnostics` is good for file-scoped type/error checks before builds.
- `lens_diagnostics` is valuable because it includes non-LSP runners.

### Proposed improvements

- Make stale/omitted files more prominent.
- For full scans, include a warning when caps mean the result is partial.
- Add `paths` to `lens_diagnostics` for focused runner-backed diagnostics, not only session/full modes.
- Separate “new from this turn” vs “pre-existing” more explicitly.

## Suggested priority

1. `read_enclosing onOversize: "slice" | "outline"` — biggest observed pain; can reuse existing symbol/callback/block outline machinery.
2. `ast_grep_search validateOnly` — cheap, sound way to distinguish invalid pattern/rule from genuine absence.
3. `module_report view: "summary"` plus section-level provenance — make the report leaner and more honest in one pass.
4. Result caps and filters where output is currently high-volume: `ast_grep_search maxMatches/maxBytes/groupByFile` and `lsp_navigation documentSymbol` `maxResults` / kind filters.
5. `read_enclosing` generic block units and selection provenance — useful, but scope carefully so the tool does not select a nested block when the caller wanted the enclosing method/function.
