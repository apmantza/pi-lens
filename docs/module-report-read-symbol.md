# Feature — `module_report` + `read_symbol` (read-substitute pair)

These two pi agent tools (also mirrored as MCP tools `pilens_module_report` /
`pilens_read_symbol`) replace the "read the whole file" pattern with a
structured, navigable flow that the model can target precisely.

## Problem

When an agent encounters an unfamiliar file, the cheapest single tool call
that gives it *some* understanding is `read`. But for any non-trivial file,
the agent doesn't actually want the whole body — it wants:

1. **Shape** — what symbols exist, their kinds, signatures, where they start.
2. **Where it fits** — what's exported, what calls it, what it imports.
3. **The body of one specific symbol** — the part it actually needs to read
   in full to make an edit, follow a call, or explain a behaviour.

A `read` on a 1000-line file dumps all three layers into the context. On a
2 k-file repo, an agent that fans out a "skim every file" pattern can
balloon the context to tens of thousands of tokens before doing any real
work.

## The pair

### `module_report(filePath, maxRefsPerSymbol?)`

Returns a structured outline of one module as JSON. The shape:

```json
{
  "available": true,
  "staleness": "fresh",
  "path": "clients/lens-engine.ts",
  "language": "jsts",
  "lineCount": 131,
  "summary": { "imports": 13, "exports": 10, "symbols": 10 },
  "imports": {
    "external": ["node:path"],
    "internal": ["clients/dispatch/integration.js", "..."]
  },
  "api":       [ /* exported ModuleSymbolEntry[] */ ],
  "internal":  [ /* non-exported ModuleSymbolEntry[] */ ],
  "recommendedReads": [ /* top-3 ranked by fanout / complexity / export */ ],
  "semantic": { "source": "review-graph", "references": true, "implementations": false }
}
```

Each `ModuleSymbolEntry`:

```json
{
  "name": "recentLatency",
  "kind": "function",
  "startLine": 77, "endLine": 89,
  "exported": true,
  "signature": "( limit = 5, fileFilter?: string, )",
  "doc": "Recent dispatch latency reports, newest first.",
  "fanout": 7, "complexity": 2,
  "flags": ["high fanout"],
  "usedBy": [
    { "file": "mcp/server.ts", "symbol": "callTool", "line": 551, "relation": "calls" }
  ]
}
```

No per-symbol `read` block (#512) — `offset`/`limit` are pure derivations of
`startLine`/`endLine` (`offset = startLine`, `limit = endLine - startLine + 1`)
and the path is the report's own top-level `path` field; repeating all three
per symbol cost real tokens for zero new information. **To read a symbol:**
call `read`/`read_symbol` with `offset=startLine, limit=endLine-startLine+1`
on THIS report's `path`. Cross-file sections keep their own path — `usedBy[].file`
(the caller's file) and `blastRadius.files[].read` (the dependent file) — since
those legitimately point elsewhere. `exported` stays a boolean only; it is NOT
also repeated inside `flags` — `flags` carries non-derivable signals only
(`async`, `high fanout`, `high complexity`, `boundary wrapper`). `doc` is the
first sentence (or line) of an attached doc comment, whitespace-collapsed and
capped ~120 chars — the highest-value token for deciding which symbol to read;
omitted when no comment is directly attached. `recommendedReads` pre-ranks the
top three by `(usedBy × 2) + complexity + (exported ? 2 : 0)
+ (high-complexity ? 3 : 0)` so the agent doesn't have to scan the whole
outline to decide where to look next; each entry carries `{reason, symbol,
startLine, endLine}` (no path — always the same file as the report).

`view: "compact"` renders the same data as a line-oriented TEXT view instead
of JSON — one line per symbol/callback, roughly a quarter of the token cost:

```text
clients/agent-nudge.ts jsts 266L — 8 symbols, 5 exported | imports: bus-publish, latency-logger
API:
  77-81    fn  _resetAgentNudgeForTests()  — Test-only: clear accumulator state.
INTERNAL:
  95-104   fn  isValidPayload(data: unknown)
CALLBACKS:
  164-172  event_handler  events.on@164  [lifecycle]  (in wireAgentNudgeSubscriber)
```

Default view stays JSON; `compact` is opt-in.

### `read_symbol(filePath, symbol, kind?)`

Returns the verbatim body of one named symbol plus a one-line header
(`<kind> <name>  <basename>:<startLine>-<endLine>`). The body is the
actual source lines the file contains — no synthesized version, no
ellipsis.

**Doc-comment inclusion (#523).** When a doc comment is directly attached to
the declaration (same position-based, blank-line-gap-aware attachment
`module_report`'s `doc` field already uses), the returned range starts at the
comment block, not the declaration line — an agent reading a symbol to edit
it needs the contract above it, not just the body. The read-guard coverage
recorded for the read is extended to match, so editing only the doc comment
on an otherwise-read symbol is not blocked as a zero-read. A symbol with no
attached comment (or one separated from the declaration by a blank line — not
"attached") behaves exactly as before.

**`Class.method` qualification (#523).** `symbol` accepts a dotted name
(`"Foo.bar"`) to resolve a specific member: the lookup searches within the
named parent's members (by line-range containment, same shape as
`module_report`'s member nesting) before falling back to a plain top-level
lookup. `read_symbol("bar", ...)` still works standalone; `read_symbol("Foo.bar",
...)` disambiguates when a member name collides across containers or isn't a
top-level export. An unresolved qualifier (unknown parent, or no matching
member) falls through to the did-you-mean miss path below rather than
erroring.

**Did-you-mean on miss (#523).** A miss (`found: false`) embeds the ~3 nearest
symbol/callback names in the file — by Levenshtein (character-edit-distance)
similarity over the name, threshold 0.45 on a 0–1 normalized score — so a
typo or near-miss self-corrects in one turn instead of a `module_report`
round-trip. Wildly-wrong names get no suggestions (nothing clears the
threshold) rather than a misleading list. (Chosen over reusing the
read-guard's `findSimilarLines`/`tokenSimilarity` — that does Jaccard
similarity over whitespace-tokenized *line content*, built for relocated-block
suggestions; a single identifier is one token to it, so a one-character typo
on a long name scores 0. Symbol names need character-level distance instead.)

**Duplicate-name disambiguation (#523).** When more than one same-file symbol
shares the requested name (overloads, an interface and a function sharing a
name), the response returns the first match (source order — unchanged
default behavior) but sets `ambiguous: { count, kinds }` and the tool/MCP
text notes it ("N matches — returned the `<kind>`; pass `kind` to
disambiguate"). Pass the optional `kind` parameter (e.g. `"function"`,
`"interface"`) to pick a specific one; a single unambiguous match never sets
`ambiguous`.

```text
function createReadSymbolTool  tools/module-report.ts:73-150

export function createReadSymbolTool(
  getProjectRoot: () => string,
  recordSymbolRead: (
    filePath: string,
    symbol: { name: string; kind: string; startLine: number; endLine: number },
  ) => void,
) {
  return {
    name: "read_symbol" as const,
    ...
  };
}
```

Crucially, `read_symbol` **records the read against the read-guard** so a
follow-up edit on any line inside the symbol's range passes the
read-before-edit check. `module_report` does **not** — an outline is shape,
not body, and shouldn't be treated as coverage for editing.

## Why a pair, not one tool

`module_report` is the **navigator**: cheap, structured, lets the agent pick
a target. `read_symbol` is the **fetch**: delivers the actual lines for one
chosen target.

The pair mirrors how a developer navigates an unfamiliar file with an IDE:

| IDE action | pi-lens tool | Notes |
|---|---|---|
| Open file outline | `module_report` | Symbols, signatures, cross-refs, ranked picks |
| Ctrl-click a symbol | `read_symbol` | The actual body, ready for edit |
| Jump to definition | `lsp_navigation({operation: "definition"})` | LSP-precise; for cross-file navigation |
| Grep + read | `grep` + `read` (lines) | For text patterns; the read-guard tie-in for ranges |

## How it works

### `module_report` (read-only by contract — #256)

1. **Tree-sitter extract** — always; one file. Produces name/kind/line range/signature for every symbol across the 18 SYMBOL_QUERIES languages plus jsts (shared query, so a TS interface and a Python class have the same fields).
2. **Review graph lookup** — `getCachedReviewGraph()` (in-memory → persisted snapshot → none). Provides `usedBy`, `imports`, `fanout`, `complexity`, `exported`. **Never builds the graph on this path** — a synchronous full build re-runs every fact provider (TS-compiler ASTs for jsts) and two racing builds OOM'd pi.
3. **Degrade tiers** — outline only on a cold graph; no LSP on this path. The honest `semantic.source` reports what backed the data so a regression is attributable per call.

### `read_symbol`

Pure tree-sitter on one file: extract → match by name → slice lines
`startLine-1 .. endLine-1`. No graph, no LSP. One log event per outcome
for correlation with `module_report` frequency/timing.

## Token-efficiency results

Measured against `read` on a representative pi-lens file set
(`tools/lsp-navigation.ts`, `clients/lens-engine.ts`,
`clients/runtime-session.ts`, `mcp/server.ts`, `index.ts`,
`tools/shared.ts`, `tools/ast-grep-search.ts`):

| Workflow | Tokens (sum) | vs `read` |
|---|---:|---:|
| `read` each file | 55,356 | — |
| `module_report` each file | 13,907 | **−75%** (4.0× cheaper) |

The pair's per-file ratio depends on file shape:

| File shape | `module_report` vs `read` | When to skip `module_report` |
|---|---:|---|
| Many small symbols (e.g. `index.ts`, 30 fns) | **6.4×** | — |
| One giant function in a long file | 0.5–1.0× | Just `read` a slice |
| Trivial utility file (≤ ~10 lines, 0 symbols) | 1.1× | Break-even — `read` is fine |

`module_report` + `read_symbol` (small target) lands at ~−60% vs `read`
for the common case. `read_symbol` (whole file is one giant symbol) is
a wash — use `read` with a line range instead.

**#512 slimming (2026-07-11):** on `clients/agent-nudge.ts` (266 lines, 8
symbols), the default JSON view dropped from measuring ~1,900 tokens
(per-symbol `read` blocks + `flags: ["exported", ...]` duplicating the
`exported` boolean + `recommendedReads` repeating `{path, offset, limit}`)
to a schema with no repeated `read`/path noise; `view: "compact"` renders the
same report as text at roughly half the byte size of the JSON view for that
file.

## When *not* to use these

- **Looking for a textual pattern across files** — use `grep` (tool in pi). `module_report` is per-file shape, not cross-file content.
- **Need exact LSP resolution** (cross-file definitions, type info) — use `lsp_navigation({operation: "definition"})`. `module_report`'s `usedBy` is AST-graph-derived; it's "this symbol calls/is-called-by" not "go to definition".
- **Tiny file (≤ ~10 lines)** — `read` is cheaper; `module_report`'s metadata overhead exceeds the file.
- **Want to edit, not read** — call `read_symbol` first (records the read), then `edit`. Don't rely on `module_report`'s outline for read-guard coverage.

## MCP mirror

Both tools are also exposed via the pi-lens MCP server:

- `pilens_module_report({file, cwd?, maxRefsPerSymbol?, focus?, view?, blastRadius?, blastRadiusDepth?})`
- `pilens_read_symbol({file, symbol, kind?, cwd?})`

The MCP wrappers return the same JSON shape plus a one-line human summary, so
an agent in Claude Code (or any MCP client) gets the same navigable flow
without needing to install the pi extension. Both surfaces are compact
(unindented) JSON by default (#512) — the payload is parsed by an agent, not
read formatted; `view: "compact"` on `pilens_module_report` returns the
line-oriented text rendering instead. `pilens_read_symbol`'s response no
longer restates its own header line in a trailing JSON block — the header
line already carries name/kind/path/range, so only `signature` (genuinely
new) is folded into it.

## See also

- `clients/module-report.ts` — implementation, single-mode rationale, per-tier degradation
- `tests/tools/module-report.test.ts` + `tests/clients/module-report.test.ts` — unit tests
- `tests/mcp/module-report.smoke.test.ts` — MCP smoke (init + real server round-trip)
- `docs/implementationplan.md` — historical context for the read-only contract (#256)
