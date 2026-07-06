# Agent-Facing Tools

pi-lens registers the following tools with the pi agent. They are also exposed
through the MCP mirror (`clients/lens-engine.ts` is the seam both adapters
share).

## Per-edit

- **`lens_diagnostics`** — Cached diagnostic state for the current session.
  Modes: `delta` (current turn), `all` (resurfaces stale blockers dropped from
  turn context), `full` (project-wide scan).
- **`lsp_diagnostics`** — File- or directory-scoped LSP diagnostics via the
  active language server.
- **`lsp_navigation`** — IDE-style navigation: `definition`, `references`,
  `implementation`, `typeDefinition`, `declaration`, `rename`, `rename_file`,
  `hover`, `documentSymbol`, `workspaceSymbol`, `signatureHelp`,
  `prepareCallHierarchy`, `incomingCalls`, `outgoingCalls`, `executeCommand`,
  and `capabilities`. Position-based operations accept a `path`/`line`/`character`
  triple. `documentSymbol` accepts a `kinds` filter (e.g. `function`, `class`)
  and a `maxResults` cap (default 20, max 100) to keep large files bounded.
- **`ast_grep_search`** — AST-aware structural search across ~40 languages via
  the `sg` CLI. Supports metavariables (`$VAR`, `$$$ARGS`), `strictness`
  modes (`smart`, `relaxed`, `ast`, `cst`, `signature`, `template`), structural
  constraints (`insideKind`, `hasKind`, `follows`, `precedes`), raw YAML `rule`
  passthrough, `validateOnly` for compile/shape checks without scanning project
  files, and pagination via `skip` / `maxMatches` (per-call cap, default 50,
  max 200; also sets the pagination step). `groupByFile: true` renders a compact
  one-line-per-file distribution (`L<line>:<col>` locations) instead of each
  match body — for high-volume searches. `pattern` is optional when a `rule` is
  given.
  Results include `details.matchLocations[]` — each hit carries a ready
  `readSlice` (`path`/`offset`/`limit`) for a bounded context read; zero-match
  results include a `suggestedDump` hint pointing at `ast_grep_dump`.
- **`ast_grep_replace`** — AST-aware structural replace. Re-validates the pattern
  against the current file before writing and reports a clear error if the
  file changed since the preview.
- **`ast_grep_dump`** — Dumps the raw tree-sitter AST for a source snippet. Use
  this when an `ast_grep_search` or `ast_grep_replace` pattern returns zero
  matches and the correct node kind or field name is unknown. `includeAnonymous`
  shows punctuation/CST nodes. (`ast_dump` remains as a compatibility alias.)
- **`ast_grep_outline`** — Syntax-only code structure (symbols, imports, exports,
  members) for files or directories via `ast-grep outline`. Fast, local, no
  index/LSP/cross-file semantics. Supports `items`/`view`/`type`/`match`/
  `pubMembers`/`globs`; returns per-file `items[]` (nested `members[]`) with
  ready `read` args. Prefer `module_report` for pi-lens-aware navigation; reach
  for this when the syntax tree's own view is enough or pi-lens's extractor is
  weak for a language.

## Project intelligence

- **`module_report`** — Navigable outline of a file: every symbol's name/kind/
  startLine/endLine/signature, exported vs internal split, class/interface
  member nesting, who-uses-this, fanout/complexity risk flags, and a
  `recommendedReads` top-3 ranked by usage + complexity. Each entry carries a
  `decorators[]` array — the declaration's decorators/attributes/annotations
  (`@app.get("/x")`, `#[tokio::main]`, `@Override`) — so the agent reads a
  symbol's role (route/test/fixture/entrypoint) without opening the body. Also emits a
  `callbacks[]` section for high-signal inline executables (event handlers,
  timers, promise callbacks, object/dict function props, assigned closures) with
  stable synthetic handles, flags, and `read` args. The optional `focus` string
  re-ranks `recommendedReads` without expanding scope. `callbackSupport`
  (`tuned`/`generic`) reports whether language-specific callback rules applied —
  the callback *node kinds* are language-uniform, but the semantics are
  per-language (JS/TS-tuned by default, plus Go goroutine/defer, Python
  scheduler/future lambda, Rust spawn/move-closure, Swift weak/strong-self
  capture, C++ by-reference-capture, Kotlin coroutine-builder, Java
  thread/executor/listener, and C# Task.Run/event-`+=` slices); named
  symbols span all tree-sitter `SYMBOL_QUERIES` languages. Pass `view: "summary"`
  for a smaller orientation payload (top-level read handles + recommendations,
  heavy callback/usedBy/blast-radius payloads omitted). Reports section-level
  `provenance` for syntax, cached-graph, and heuristic sections. Pass
  `blastRadius: true` for cross-file transitive dependents (read-only over the
  cached graph).
- **`read_symbol`** — One symbol's verbatim source body, by name or by a
  `module_report` callback handle. Returned body is recorded as genuine
  read-guard coverage for that symbol/callback's line range.
- **`read_enclosing`** — Maps a `path` + `line` (from `ast_grep_search`,
  diagnostics, or LSP locations) to the verbatim body of the smallest enclosing
  symbol or callback. Tree-sitter only — no LSP or graph build. Optional `kinds`
  filter and `maxLines` cap; records read-guard coverage for the returned range.
  When the body exceeds `maxLines`, `onOversize` controls the fallback: `error`
  (default) returns metadata only, `slice` returns a bounded partial read around
  the line (size via `aroundLine`, default `maxLines` then 80), and `outline`
  returns the nested symbols/callbacks with read handles.

## Session

- **`lens_health`** — Runtime health, latency telemetry, and current LSP
  status.
- **`lens_project_scan`** — Cheap project-wide scans (knip, jscpd, duplicates).
- **`lens_diagnostics mode=full`** — full project-wide review: LSP + the cached
  heavyweight analyzers (jscpd, madge, gitleaks, govulncheck, trivy, dead-code)
  folded in via `refreshRunners`.
