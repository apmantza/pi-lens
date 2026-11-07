# RFC 5138: `symbol_search` query surface

**Status:** PR 2 scope implemented (#5135). PR 0 (instrument, #5355) is open; PR 3 (schema
projection) and PR 4 (D9 step b) are pending.

**Tracking Issue:** [apmantza/pi-lens#5138](https://github.com/apmantza/pi-lens/issues/5138)

**Related Issues/PRs:** #5135 (listing + contract), #5136 (`ext:` suffix match), #5288 (D9 step a)

**Authors:** `rfc5135` lane

Decision IDs below are the ones on the tracking issue (D1–D8), extended by D9 and the rulings the
maintainer recorded on 2026-11-04. They are cited by those IDs in review, in PR bodies, and in
`AGENTS.md`-adjacent prose, so a renumbering would break every cross-reference.

## 1. Problem

A filter-only `symbol_search` query (`file:clients/`, `-file:test`) returned an empty result and
rendered `No files matched`, which reads as "nothing exists". A term-less call with structured
`paths` reached the same early return, so the inline and structured entry paths diverged. An empty
query also differed by surface: pi rendered `No files matched ""` while MCP answered `Provide a
non-empty query.`

The `lang` filter resolved through two tables: inline `lang:` used `KIND_EXTENSIONS` (file kinds),
structured `lang` used the language registry (ids). A kind such as `jsts` therefore worked inline
but not structured, and an unknown value answered "no match" instead of refusing.

The same root cause produced three more wrong answers, measured in #5138's census: an unknown
`severity` disabled the filter, an unknown `read_symbol.kind` fell back to all kinds, and an
unreadable file read as `found: false` — each a silent default where a refusal belonged.

## 2. Decisions

| ID | Decision | Enforcement |
| --- | --- | --- |
| **D1** | **The key set is closed and named.** `lang`, `file`, `ext`, in `WORD_INDEX_QUERY_FILTER_KEYS`. | Adding, renaming, or removing a key requires an amendment here. Enforced behaviourally in `tests/clients/word-index.test.ts`: `recognises exactly lang, file, and ext as filter keys` reds on a fourth key, and `keeps an unknown prefix as a literal search term` reds if an unknown prefix starts filtering. |
| **D2** | **Every key validates its value or is documented as free-form.** `lang:` resolves through one owner and refuses an unknown token; `file:` is free-form by design (substring); `ext:` is **permissive** — `ts`, `.ts`, and `test.ts` all match a path suffix, with no shape validation (maintainer: "permissive `-ext`"). | A known key with a bad value refuses, naming the accepted values. `file:`/`ext:` never refuse. |
| **D3** | **A term-less query that carries a scope returns the scope listing.** Inline filters, or structured `paths`/`lang`. The listing seeds score 1 and runs the **same** prior block and comparator as a term search, so a demoted file cannot hide behind the alphabetical tie-break. | `searchWordIndex(index, "file:clients/")` returns the files under `clients/`, and a term-less call with `paths: ["clients/"]` returns the same set shape. Neither renders `No files matched` while its predicate matches. |
| **D4** | **Structured arguments are the contract; inline filters are sugar — and the two vocabularies are mapped, not identical.** `lang` is the one aligned pair; `file:` is a substring on the display path while `paths` is a subtree glob; `ext:` has no structured twin. | A mapping table (§3) and cells pinning each relationship, including the deliberate `file:`/`paths` difference (@Don-Yin, #5135). |
| **D5** | **Kind vocabulary is LSP `SymbolKind`.** If `kind:` is ever added its values are LSP kind names, not pi-lens-local synonyms. | **Parked** (maintainer: "kind: stays parked"). No `kind:` key exists, and the tool schema and docs carry no second vocabulary. |
| **D6** | **Unknown prefixes stay literal terms, and the description says so.** `std::vector`, `http://…`, `C:\paths`, and `TODO:tag` keep searching as terms. | The tool description states the policy. Its identity pin (below) reds if the sentence is dropped or reworded. |
| **D7** | **The accepted surface is pinned.** The description text and the key list are model-facing and re-read every session. | The description is pinned by identity on both surfaces: `tests/tools/symbol-search.test.ts` (`the tool's own description is the exported constant`) and `tests/mcp/symbol-search.smoke.test.ts` (`advertises the query contract sentence`), so text and code cannot drift apart again. |
| **D8** | **Measured, not assumed, on a named population.** Accepted when the empty-result rate falls and the same-file repeat-read rate does not rise, for queries that carry an inline `file:` or `ext:` filter — not for every scoped query. | `scripts/symbol-search-query-metrics.mjs` reports `emptyRate` over that population (an error is not an answer, so it stays in the denominator and prints as `scopedError`), `repeatReadRate` (any read after the session's first listing of a file it had already read; no window), `drilldownRate`, and `unscannableRate` (fail-closed: any `symbol_search` occurrence it cannot read as a literal call is unscannable, never dropped). Misses scoped by `paths`/`lang` print as `structuredScoped` counts, not a rate. `--since`/`--until` bracket each merge. No CI gate. |
| **D9** | **One failure policy.** A known key with a bad value fails loudly on every surface; a value that is merely unresolvable never reads as a match. | Step (a), patch level, merges the three wrong-answer sites (#5288). Step (b), schema-wide value refusal, is PR 4 and flips run→refuse, so it carries the `docs/public-api-stability.md` amendment and the maintainer sign-off. |

### Rulings on record

- **D9 step (a) is a bug fix, step (b) is a contract change.** Maintainer, 2026-11-04: fix
  `severity`, `read_symbol.kind`, and the unreadable-file case now; do the schema-wide refusal with
  PR 4.
- **No exemption list.** The seam refuses whatever the schema declares, so a per-tool opt-out cannot
  grow.
- **A valid kind with no extensions refuses** (`terragrunt`), and the refusal names the
  `file:terragrunt.hcl` route as the way in. It stays in the D9 census so PR 4 handles it instead of
  leaving a silent empty.
- **A call with neither terms nor scope is an `isError` refusal**, with one sentence shared by both
  surfaces. A term-less call that carries a scope returns a listing — the two entry paths must not
  diverge (Q4, from @Don-Yin's #5135 finding).
- **Project the MCP `inputSchema` from the pi `parameters`** (PR 3), and adopt `constrainedSampling`
  on the enum-bearing tools. Order is PR 0 → PR 4 with no folds, so validation is written once
  against one schema source.
- **Prose is derived.** The schema constant owns the sentence, docs link to it, and a doc that
  restates behaviour is a bug.

## 3. `lang`, `file`, `ext`, and `paths` mapping

The inline filter and the structured argument are NOT interchangeable for every key; only `lang` is
an aligned pair.

| Surface form | Semantics |
| --- | --- |
| inline `file:<substr>` | substring match on the index's display path (`resolveWordIndexFilter`) |
| structured `paths: [...]` | subtree glob matched relative to `cwd` (`fileMatchesPathGlobs`) |
| inline `ext:<ext>` | suffix match with no structured twin |
| inline `lang:<kind\|id>` / structured `lang` | the one aligned pair, both resolved by `resolveLanguageScope` |

So `file:clients/` also matches a nested `tests/clients/...`, while `paths: ["clients/"]` scopes
only the root `clients/` subtree. The tool description owns the query contract; this table links to
it rather than restating it.

## 4. Surface contract

- A listing row is a `file` row: `  N. <path>` with no score, no line, and no hit count. The
  producer (`RankedFile.kind`) owns the shape; the renderer never infers it from a hit count or an
  empty line list and never fabricates a line.
- A term search row is a `symbol` row: path, best-matching line, score, hit count, and any graph
  annotations.
- The refusal sentence and the description live in one place. Docs link to them; a doc that restates
  behaviour is a bug.

## 5. Sequence

| # | Slice | State |
| --- | --- | --- |
| 0 | `scripts/symbol-search-query-metrics.mjs` (measurement only) | open, #5355; the maintainer is finishing the review items on that branch |
| 1 | `ext:` suffix match (#5136) | merged, #5282 |
| 1b | D9 step (a), three wrong-answer sites (#5288) | merged |
| 2 | Listing, `lang` owner, description owner (#5135) | this change |
| 3 | MCP `inputSchema` projected from `parameters`, `constrainedSampling` | pending |
| 4 | D9 step (b), schema-wide value refusal plus identity ratchets | pending |

## 6. Non-goals

- `kind:` key support is parked on #5138.
- Schema-wide value enforcement is PR 4.
- A valid kind with no extensions (`terragrunt`) stays a documented gap owned by PR 4, which refuses
  it and names the `file:terragrunt.hcl` route.
- No AST or Cypher query language, no new tool names, no alias removal.

## 7. Verification

The PR body carries the red-then-green cell transcripts and the hand-mutation rows (prior
multiplier, inline-filters guard, `file`/`symbol` discriminator, `rows()` throw guard, filter key
set). The cells live in `tests/clients/word-index.test.ts`, `tests/tools/symbol-search.test.ts`,
`tests/mcp/symbol-search.smoke.test.ts`, and `tests/clients/language-registry-drift.test.ts`.

Two guards deliberately do not exist. There is no separate "exported key list" arch test: the
key-set cells above drive `parseWordIndexQuery`, so they already probe that population at runtime,
and a spelling-level duplicate would add no coverage. There is also no "no doc restates the
contract" sweep: Q8's enforcement is the identity pin on the description plus docs that link to it,
and a lexical sweep over prose would red on quoting the sentence it is trying to forbid.
