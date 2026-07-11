# Feature — word index + `symbol_search` (discovery funnel)

An identifier-aware inverted index over source files, ranked with BM25, that
answers "which files are most relevant to `<query>`" by identifier — the
lexical half of the "codebase mental model" ask (#162). Implementation:
`clients/word-index.ts`.

## What it is

- **Inverted index**: one posting per `(token, file, line)` — a token
  repeated on the same line counts once, so term frequency is "lines
  mentioning the token", not raw occurrence count.
- **BM25 ranking** (`k1=1.2`, `b=0.75`) over the query's identifier tokens.
- **Priors**: files under `tests?/__tests__/spec/vendor/node_modules/
  examples?/fixtures?/dist/build/coverage` (or matching `.test.`/`.spec.`)
  are demoted ×0.3; doc/data files (`.md`, `.json`, `.yml`, `.lock`, …) are
  demoted ×0.5 — so a real source match isn't starved by a README or a test
  fixture repeating the same identifier.
- **Optional graph-centrality boost**: when the project snapshot's
  `reverseDeps` (importedBy) is available, well-connected files get a
  `1 + log(1 + importers)/4` multiplier (`centralityFromReverseDeps`) — a
  file many others import ranks a little higher for the same BM25 score.

It complements rather than duplicates the host's `grep`: grep finds raw
substrings, this ranks files by identifier relevance.

## Tokenization

`splitIdentifier` (`clients/word-index.ts`) splits each identifier across
camelCase, PascalCase, snake_case, kebab-case, dotted, and digit boundaries,
lowercases every piece, drops sub-tokens under 2 chars, and filters a small
language-agnostic stopword list (`the`, `const`, `function`, `async`, `pub`,
`impl`, …). The whole lowercased identifier is kept alongside its parts:

```
getUserByID   → getuserbyid, get, user, by, id
MAX_RETRY_2   → max_retry_2, max, retry, 2
HTTPServer    → httpserver, http, server
```

`tokenizeLine` extracts identifier-shaped substrings from a line and runs
each through `splitIdentifier`; queries are tokenized the same way so
`"authenticate user"` matches `authenticateUser`, `auth_user`, etc.

## Lifecycle

The index is built/refreshed in **every** startup mode: load the persisted
copy from the project snapshot, rebuild if stale by project seq, persist
back into the same snapshot (`serializeWordIndex`/`deserializeWordIndex`).
It shares one file-walk-and-read implementation (`collectWordIndexDocs`)
across every build path — session-start, quick-mode warmup, and the cold
background trigger — so a bound or skip-rule change lands once.

`symbol_search` / `pilens_symbol_search` are otherwise stateless callers: no
`RuntimeCoordinator`, no session lifecycle, just a synchronous read of the
persisted snapshot. When no index exists yet for a workspace (an MCP-only
session that never ran `pilens_session_start`, or the session-start build
hasn't finished), the call never blocks on a project walk — it fires a
single bounded background build (`triggerBackgroundWordIndexBuild`, deduped
per resolved cwd) and returns `available: false` with an honest retry hint
immediately (#348 phase 1, decision 3).

## Warm per-edit maintenance (#348 phase 2)

At the per-edit cascade seam (`clients/dispatch/integration.ts`,
`computeCascadeForFile` / `updateWordIndexForCascade`), the warm in-memory
index is updated incrementally instead of waiting for the next full
rebuild:

- A **forward index** (`WordIndex.forward`: file → token → distinct-line
  count) records exactly what each file contributed, so a single-document
  replace (`updateWordIndexDocument`) only touches that file's own tokens —
  no scan of unrelated postings. `removeWordIndexDocument` is the same
  operation in reverse.
- Indexes without a forward map (pre-phase-2, or deserialized from an older
  snapshot shape) refuse the incremental update and fall back to the next
  full rebuild — never a partially-consistent patch.
- A file over `WORD_INDEX_MAX_BYTES` is removed from the index rather than
  partially indexed.
- The incremental path is **equivalence-tested** against a from-scratch
  rebuild: `tests/clients/word-index-incremental.test.ts` asserts that k
  incremental edits produce the same index a full rebuild over the same end
  state would.
- Persistence is **debounced**, not synchronous per edit — a burst of edits
  coalesces into one write after a quiet window (default 1500ms, override
  via `PI_LENS_WORD_INDEX_PERSIST_DEBOUNCE_MS`), reusing the same
  `createDebounceScheduler` primitive the review graph's persist path uses
  (`scheduleWordIndexPersist`, `clients/word-index.ts`).

## Surfaces

- **pi tool `symbol_search`** (`tools/symbol-search.ts`) and **MCP
  `pilens_symbol_search`** (`mcp/server.ts`) both call the same engine
  function, `symbolSearch()` in `clients/lens-engine.ts`.
- First step of the **discovery funnel**: `symbol_search` finds candidate
  files by identifier → `module_report` explains one → `read_symbol` reads
  the exact body. See [docs/module-report-read-symbol.md](module-report-read-symbol.md)
  for the second half of that chain.
- **Hit shape** (#517-slimmed): `{ file, score, hits, startLine, endLine }`.
  `startLine`/`endLine` mark the file's single best-matching line (there's
  no synthesized whole-file span) — derive a one-line peek with
  `offset=startLine, limit=endLine-startLine+1`, or call `module_report` on
  `file` for the real outline.
- **Staleness hint (MCP only, #536)**: `symbolSearch()` returns
  `snapshotGeneratedAt` (the backing project snapshot's `generatedAt`); the
  MCP handler turns an old timestamp into a human staleness note
  (`graphStalenessNote` in `mcp/server.ts`) suggesting `pilens_analyze`,
  `pilens_session_start`, or `pilens_rebuild`. The pi tool surface omits
  this field — its index is kept warm per-edit, so staleness isn't a
  concern there the way it is for a possibly-idle MCP session.

## MCP freshness

A warm-mode `pilens_analyze` call also updates the word index synchronously
in memory (same #536 seam that maintains the review graph), so a
`pilens_symbol_search` immediately following an analyze in the same process
sees the update before the debounced disk persist flushes (#536/#539,
`getOrLoadWarmWordIndex` in `clients/mcp/analyze.ts`). `symbolSearch()`
prefers this warm copy over a fresh disk read whenever one is cached for
the cwd, falling back to the stateless snapshot read otherwise.

## Caps and boundaries

- **≤6000 files, ≤512KB per file** (`WORD_INDEX_MAX_FILES`,
  `WORD_INDEX_MAX_BYTES` in `clients/word-index.ts`) — shared by every
  build path and the per-edit update path alike.
- **Deletions aren't plumbed at the per-edit seam** — the cascade only ever
  sees an edited file's post-write content, never a delete event. A removed
  file ages out at the next full rebuild (session-start lifecycle), the
  same scope boundary the review graph accepts for deletes.
- **What it is not**: not a substring/trigram index — raw substring search
  is `grep`'s job, not this index's. Not a semantic/embedding index — no
  vector store, no model call; pure deterministic BM25 over identifier
  tokens, zero new dependencies.

## See also

- `clients/word-index.ts` — implementation, tokenization, BM25, persistence,
  cold-build trigger, debounced per-edit persist
- `tools/symbol-search.ts` — pi tool wrapper
- `mcp/server.ts` (`pilens_symbol_search` handler) — MCP wrapper + staleness note
- `clients/lens-engine.ts` (`symbolSearch`) — the shared engine seam both surfaces call
- `clients/dispatch/integration.ts` (`updateWordIndexForCascade`,
  `computeCascadeForFile`) — the per-edit maintenance seam
- `tests/clients/word-index.test.ts`, `word-index-incremental.test.ts`,
  `word-index-per-edit.test.ts`, `word-index-persist.test.ts`,
  `word-index-lifecycle.test.ts` — unit + equivalence tests
- `tests/tools/symbol-search.test.ts` — pi tool test
- [docs/module-report-read-symbol.md](module-report-read-symbol.md) — the
  next two steps of the discovery funnel
