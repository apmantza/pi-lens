# RFC 5138: `symbol_search` query surface

**Status:** PR 2 scope implemented (#5135, 2026-11-04)  
**Tracking Issue:** [apmantza/pi-lens#5138](https://github.com/apmantza/pi-lens/issues/5138)  
**Related Issues/PRs:** #5135 (listing + contract), #5136 (`ext:` suffix match)  
**Authors:** `rfc5135` lane

## 1. Problem

A filter-only `symbol_search` query (`file:clients/`, `-file:test`) returned an
empty result and rendered `No files matched`, which reads as "nothing exists".
A term-less call with structured `paths` reached the same early return, so the
inline and structured entry paths diverged. An empty query also differed by
surface: pi rendered `No files matched ""` while MCP answered
`Provide a non-empty query.`

The `lang` filter resolved through two tables: inline `lang:` used
`KIND_EXTENSIONS` (file kinds), structured `lang` used the language registry
(ids). A kind such as `jsts` therefore worked inline but not structured, and an
unknown value answered "no match" instead of refusing.

## 2. Decisions

| ID | Decision |
| --- | --- |
| D1 | The filter key set is closed at `lang`, `file`, `ext`. An unknown `key:` prefix is a literal search term, never a filter and never an error. |
| D2 | A term-less query that carries a scope — inline filters, or structured `paths`/`lang` — returns a **listing** of the scoped indexed files, seeded at score 1 and ordered by the SAME prior block and comparator as a term search. |
| D3 | A call with neither terms nor scope is an `isError` refusal with one sentence shared by the pi and MCP surfaces. |
| D4 | `resolveLanguageScope(token)` in `clients/language-registry.ts` is the single `lang` owner. It accepts a FileKind (`jsts`, `cxx`) or a language id/grammar name (`typescript`, `bash`); an unknown token REFUSES, naming both vocabularies, instead of resolving to an empty match. |
| D5 | The tool description is the owner of the model-facing prose. `tools/symbol-search.ts` exports the description and the `query` contract sentence; `mcp/server.ts` imports both. PR 3's schema projection replaces the import with the projected `parameters` object. |

### `lang`, `file`, `ext`, and `paths` mapping

The inline filter and the structured argument are NOT interchangeable for every
key; only `lang` is an aligned pair.

| Surface form | Semantics |
| --- | --- |
| inline `file:<substr>` | substring match on the index's display path (`resolveWordIndexFilter`) |
| structured `paths: [...]` | subtree glob matched relative to `cwd` (`fileMatchesPathGlobs`) |
| inline `ext:<ext>` | suffix match with no structured twin |
| inline `lang:<kind\|id>` / structured `lang` | the one aligned pair, both resolved by `resolveLanguageScope` |

So `file:clients/` also matches a nested `tests/clients/...`, while
`paths: ["clients/"]` scopes only the root `clients/` subtree. The tool
description owns the query contract; this table links to it rather than
restating it.

## 3. Surface contract

- A listing row is a `file` row: `  N. <path>` with no score, no line, and no
  hit count. The producer (`RankedFile.kind`) owns the shape; the renderer never
  infers it from a hit count or an empty line list and never fabricates a line.
- A term search row is a `symbol` row: path, best-matching line, score, hit
  count, and any graph annotations.
- The refusal sentence and the description live in one place. Docs link to
  them; a doc that restates behaviour is a bug.

## 4. Non-goals

- `kind:` key support is parked on #5138.
- Schema-wide value enforcement is PR 4.
- A valid kind with no extensions (`terragrunt`) stays a documented gap owned by
  PR 4.

## 5. Verification

The PR body carries the red-then-green cell transcripts and the hand-mutation
rows (prior multiplier, inline-filters guard, `file`/`symbol` discriminator,
`rows()` throw guard). `tests/clients/word-index.test.ts`,
`tests/tools/symbol-search.test.ts`, `tests/mcp/symbol-search.smoke.test.ts`, and
`tests/clients/language-registry-drift.test.ts` hold the cells.
