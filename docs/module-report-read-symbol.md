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
  "fanout": 7, "complexity": 2,
  "flags": ["exported", "high fanout"],
  "usedBy": [
    { "file": "mcp/server.ts", "symbol": "callTool", "line": 551, "relation": "calls" }
  ],
  "read": { "path": "clients/lens-engine.ts", "offset": 77, "limit": 13 }
}
```

`read` is a **ready-to-use `read` tool call** — the agent can paste it into
the next invocation without re-deriving path/offset/limit. `recommendedReads`
pre-ranks the top three by `(usedBy × 2) + complexity + (exported ? 2 : 0)
+ (high-complexity ? 3 : 0)` so the agent doesn't have to scan the whole
outline to decide where to look next.

### `read_symbol(filePath, symbol)`

Returns the verbatim body of one named symbol plus a one-line header
(`<kind> <name>  <basename>:<startLine>-<endLine>`). The body is the
actual source lines the file contains — no synthesized version, no
ellipsis.

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

## When *not* to use these

- **Looking for a textual pattern across files** — use `grep` (tool in pi). `module_report` is per-file shape, not cross-file content.
- **Need exact LSP resolution** (cross-file definitions, type info) — use `lsp_navigation({operation: "definition"})`. `module_report`'s `usedBy` is AST-graph-derived; it's "this symbol calls/is-called-by" not "go to definition".
- **Tiny file (≤ ~10 lines)** — `read` is cheaper; `module_report`'s metadata overhead exceeds the file.
- **Want to edit, not read** — call `read_symbol` first (records the read), then `edit`. Don't rely on `module_report`'s outline for read-guard coverage.

## MCP mirror

Both tools are also exposed via the pi-lens MCP server:

- `pilens_module_report({file, cwd?, maxRefsPerSymbol?})`
- `pilens_read_symbol({file, symbol, cwd?})`

The MCP wrappers return the same JSON shape plus a one-line human summary,
so an agent in Claude Code (or any MCP client) gets the same navigable
flow without needing to install the pi extension.

## See also

- `clients/module-report.ts` — implementation, single-mode rationale, per-tier degradation
- `tests/tools/module-report.test.ts` + `tests/clients/module-report.test.ts` — unit tests
- `tests/mcp/module-report.smoke.test.ts` — MCP smoke (init + real server round-trip)
- `docs/implementationplan.md` — historical context for the read-only contract (#256)
