# pi-lens — agent context

## What it is
A pi coding-agent extension that runs automated checks on every file write/edit. Dispatches parallel runners (LSP, biome, ruff, ast-grep, tree-sitter, type coverage, jscpd, knip) and injects findings as context injections at turn-end and session-start.

## Key source layout
```
index.ts                  Extension entry point (async factory)
clients/
  runtime-session.ts      session_start handler — tool preinstall, background scans, LSP warm
  installer/index.ts      Auto-install + ensureTool; probe-cache.json for fast restarts
  lsp/                    37 LSP servers, config, lifecycle
  dispatch/               Pipeline dispatcher + 48 runners
  widget-state.ts         Footer widget rendering (@earendil-works/pi-tui)
tools/                    ast-grep-search, lsp-navigation tool handlers
tests/                    Vitest test suite (mirrors clients/ structure)
```

## Package scope
All pi packages are `@earendil-works/*` (migrated from `@mariozechner/*` in 0.74.0). Peer dep: `@earendil-works/pi-coding-agent`. Runtime dep: `@earendil-works/pi-tui`.

## Commands
```
npm test              # vitest run (all tests)
npx tsc --project tsconfig.json --noEmit   # type-check
npm run lint          # same as type-check
```

## Debug logs
- `~/.pi-lens/sessionstart.log` — timestamped lines for every session_start event and tool lifecycle
- `~/.pi-lens/latency.log` — NDJSON per-runner timings
- `~/.pi-lens/probe-cache.json` — tool binary path cache (TTL 24h)
- `.pi-lens/cache/` — knip, jscpd, todo-baseline, turn-end-findings caches

## Lifecycle and pipeline flow

Four hooks in `index.ts` drive everything:

**`session_start`** → `handleSessionStart` (`clients/runtime-session.ts`)
Resets `RuntimeCoordinator`. Fires tool preinstall (typescript-language-server, biome, etc.) and background scans (knip, jscpd, ast-grep exports, project index) as fire-and-forget tasks. LSP config walk is deferred via `setImmediate`. Returns in ~150ms; background tasks finish asynchronously.

**`tool_call`** (write/edit events) → inline handler in `index.ts`
Warms the LSP for the file, records read-guard lines. If the tool is a write/edit, triggers the dispatch pipeline: format → autofix → LSP diagnostics sync → parallel runner dispatch → dedup/merge → findings stored on `RuntimeCoordinator`.

**`tool_result`** → `handleToolResult` (`clients/runtime-tool-result.ts`)
Tracks modified file ranges per turn for turn_end targeting. Triggers the test runner when a relevant source file changed.

**`turn_end`** → `handleTurnEnd` (`clients/runtime-turn.ts`)
Runs jscpd (duplicate code), madge (circular deps), and the test runner against files modified this turn. Deduplicates findings against the previous turn's output, then injects blockers (🔴) and advisories into the agent's context.

## Key abstractions

**`RuntimeCoordinator`** (`clients/runtime-coordinator.ts`) — session-scoped singleton passed through most of the stack.
Key fields: `projectRoot`, `sessionGeneration` (incremented on each `session_start`), `cachedExports` (symbol→file map from ast-grep startup scan), `cachedProjectIndex` (structural similarity index), `complexityBaselines` (per-file complexity for regression detection), `projectRulesScan` (custom ast-grep rules found in the project).

**`DispatchContext`** — built per dispatch by `createDispatchContext()` in `clients/dispatch/dispatcher.ts`.
Holds: `filePath`, `cwd`, `kind` (`FileKind` — ts/js/py/go/rust/css/etc.), `runtime` (the coordinator), `lspService`, `facts` (FactStore), and a `checkToolAvailability(cmd)` helper that caches availability per session.

**`FactStore`** — session+turn-scoped key-value store. Runners use it to cache tool availability checks (e.g., "is biome installed?") so subsequent dispatches within the same session skip the spawn. Set/get via `facts.setSessionFact` / `facts.getSessionFact`.

**`FileKind`** — union type (`"typescript"` | `"javascript"` | `"python"` | `"go"` | `"rust"` | …) detected from the file path. Controls which of the 48 runners are eligible for a given dispatch. Runners declare `appliesTo: FileKind[]`; an empty array means "all kinds".

## Session-start critical path
`lsp-config` is deferred via `setImmediate` (not awaited). Tool availability probes use the probe cache before spawning binaries. Interactive path target: ~150ms on warm runs.

## Tree-sitter rules

Rules live in `rules/tree-sitter-queries/<language>/`. Disabled rules are in `rules/tree-sitter-queries/<language>-disabled/` — they load in tests (via `getAllQueries()`) but are excluded from the production dispatch runner (which calls `getQueriesForLanguage("typescript")`).

**`inline_tier` values:**
- `blocking` — finding blocks the agent turn (🔴 injected)
- `warning` — advisory finding
- `review` — low-priority suggestion

**Currently blocking TypeScript rules (security):** `debugger`, `default-not-last`, `duplicate-function-arg`, `empty-switch-case`, `eval`, `infinite-loop`, `self-assignment`, `sql-injection`, `switch-case-termination`, `unsafe-regex`, `ts-command-injection` (S2076), `ts-ssrf` (S5146), `ts-xss-dom-sink` (S5696), `ts-dynamic-require` (S5335), `ts-open-redirect` (S6105), `ts-nosql-injection` (S5147).

**Tree-sitter query authoring — critical constraint:**  
`[...]` alternative groups require ALL alternatives to share the same capture names. If two groups of patterns need different captures (e.g., assignment patterns with `@PROP/@VALUE` vs call patterns with `@OBJ/@FN/@ARG`), split into two separate `[...]` blocks:
```
[ (assignment_expression ...) @PROP @VALUE ... ]
[ (call_expression ...) @OBJ @FN ... ]
```
Mixing different capture names in one `[...]` block causes tree-sitter to silently return zero matches (no compile error). Similarly, field values cannot be alternative groups: `right: [(identifier) (call_expression)]` is invalid — expand into separate alternatives or separate blocks.

**Post-filters** (`post_filter` in YAML, `applyPostFilter` in `clients/tree-sitter-client.ts`): evaluated after query matching to reject false positives. Key ones: `count_params` (long-param-list: excludes optional/defaulted params), `ts_ssrf_sink` (requires URL to look like external input), `check_secret_pattern` (variable name must match secret-sounding pattern).

## Current version / state
v3.8.41 published. Master has scope migration + startup optimizations + blocking rule additions (unreleased). CI runs `npm ci` + tsc lint + vitest.

## Conventions
- TypeScript ESM throughout (`"type": "module"`)
- Tests use vitest; mocks via `vi.mock` / `vi.hoisted`
- Fire-and-forget background work uses `void expr` or `setImmediate`
- `logSessionStart()` is a no-op in test mode (`VITEST` env var)
- LSP tool: use `goToDefinition` / `findReferences` before grepping for symbols
