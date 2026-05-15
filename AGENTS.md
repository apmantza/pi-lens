# pi-lens — agent context

## What it is
A pi coding-agent extension that runs automated checks on every file write/edit. Dispatches async parallel runners (LSP, biome, ruff, ast-grep, tree-sitter, type coverage, jscpd, knip, Madge, and language-specific linters/build checks) and injects findings as context injections at turn-end and session-start.

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
npm run build         # emit JS from TS; run before tests after source changes if stale JS may be present
```

Because many test imports use `.js` specifiers while the source of truth is `.ts`, recompile after TS changes before running tests when local `.js` artifacts may exist/stale:
```
npm run build && npm test
```
Do not hand-edit generated `.js`; regenerate it from the corresponding `.ts`.

## Debug logs
- `~/.pi-lens/sessionstart.log` — timestamped lines for every session_start event and tool lifecycle
- `~/.pi-lens/latency.log` — NDJSON per-runner timings
- `~/.pi-lens/probe-cache.json` — tool binary path cache (TTL 24h)
- `.pi-lens/cache/` — knip, jscpd, todo-baseline, turn-end-findings caches

## Lifecycle and pipeline flow

Four hooks in `index.ts` drive everything:

**`session_start`** → `handleSessionStart` (`clients/runtime-session.ts`)
Resets `RuntimeCoordinator`. Fires tool preinstall (typescript-language-server, biome, etc.) and background scans (knip, jscpd, ast-grep exports, project index) as fire-and-forget tasks. LSP config walk is deferred via `setImmediate`. Returns in ~150ms; background tasks finish asynchronously. Knip/jscpd startup scans are async and guarded against duplicate in-flight scans.

**`tool_call`** (write/edit events) → inline handler in `index.ts`
Warms the LSP for the file and records read-guard lines. For write/edit tools, records read-guard preflight data before the later `tool_result` dispatch.

**`tool_result`** → `handleToolResult` (`clients/runtime-tool-result.ts`)
Tracks modified file ranges per turn for turn_end targeting. For write/edit events, runs the dispatch pipeline: format → autofix → LSP diagnostics sync → parallel async runner dispatch → dedup/merge → findings stored on `RuntimeCoordinator`.

**`turn_end`** → `handleTurnEnd` (`clients/runtime-turn.ts`)
Merges unresolved inline blockers and cascade findings, runs Knip delta analysis when the startup scan is not in flight, runs Madge circular-dependency checks for files whose imports changed, and fires related/failed tests asynchronously for the next context injection. Deduplicates findings against previous turn state and injects blockers (🔴) and advisories into the agent's context.

## Key abstractions

**`RuntimeCoordinator`** (`clients/runtime-coordinator.ts`) — session-scoped singleton passed through most of the stack.
Key fields: `projectRoot`, `sessionGeneration` (incremented on each `session_start`), `cachedExports` (symbol→file map from ast-grep startup scan), `cachedProjectIndex` (structural similarity index), `complexityBaselines` (per-file complexity for regression detection), `projectRulesScan` (custom ast-grep rules found in the project).

**`DispatchContext`** — built per dispatch by `createDispatchContext()` in `clients/dispatch/dispatcher.ts`.
Holds: `filePath`, language-root `cwd`, `kind` (`FileKind` — `jsts`, `python`, `go`, `rust`, `css`, etc.), `pi` flags, `facts` (FactStore), `blockingOnly`, `modifiedRanges`, and `hasTool(cmd)` / `log()` helpers.

**`FactStore`** — session+turn-scoped key-value store. Runners use it to cache tool availability checks (e.g., "is biome installed?") so subsequent dispatches within the same session skip the spawn. Set/get via `facts.setSessionFact` / `facts.getSessionFact`.

**`FileKind`** — union type (`"jsts"` | `"python"` | `"go"` | `"rust"` | …) detected from the file path. Controls which runners are eligible for a given dispatch. Runners declare `appliesTo: FileKind[]`; an empty array means "all kinds".

## Session-start critical path
`lsp-config` is deferred via `setImmediate` (not awaited). Tool availability probes use the probe cache before spawning binaries. Interactive path target: ~150ms on warm runs.

## Runner process model
- Prefer `safeSpawnAsync()` for all subprocess work in hook paths (`session_start`, write/edit `tool_result`, `turn_end`, formatter pipeline, and dispatch runners). `safeSpawn()` is deprecated and blocks the Node event loop.
- Expensive project scans have in-flight guards: Knip by project root, jscpd by project root + scan params, Madge by project root/file or project root scan.
- Check cheap filesystem/root preconditions before availability probes or auto-install. Example: Knip/jscpd/Madge skip non-project or empty roots before probing/installing tools.
- `createAvailabilityChecker()` now exposes `isAvailableAsync()`; use it in runners. The sync `isAvailable()` remains only for legacy/test compatibility.
- Formatter execution (`clients/formatters.ts::formatFile`) uses `safeSpawnAsync()` so timeout wrappers are meaningful.

## Open design TODOs

- **LSP server preference via project config** — `clients/lsp/config.ts` supports `.pi-lens/lsp.json` with `disabledServers` and custom server entries, but there is no way to express a *preference* between built-in candidates (e.g. prefer `basedpyright` over `pyright` when both are installed). `PythonServer.spawn()` currently uses first-found-wins ordering (`pyright-langserver` before `basedpyright-langserver`). A future `preferredServer` key in `LSPConfig` should let projects override this ordering; the server policy layer (`clients/lsp/server-policy.ts`) is the right place to apply the preference before candidate resolution.

## Legacy async-cleanup TODO
- Migrate remaining `runner-helpers.ts` sync compatibility paths (`isAvailable()`, `isSgAvailable()`, `resolveLocalFirst()`) to async callers, then remove or clearly quarantine the sync APIs.
- Add async `sg` availability/command resolution and migrate `python-slop`/other sg CLI consumers away from sync `isSgAvailable()` probes.
- Convert remaining formatter detection/install helper probes in `clients/formatters.ts` (e.g. rubocop gem install, rustfmt install, Go env checks, csharpier probes) from `safeSpawn()` to `safeSpawnAsync()` or installer-managed async helpers.
- Audit explicit command flows such as `/lens-booboo` for remaining full-project `safeSpawn()` calls; they are lower priority than hook paths but should not freeze the TUI.
- Keep tests mocking both `safeSpawn` and `safeSpawnAsync` where legacy compatibility remains; prefer async mocks for new runner tests.

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
v3.8.44 is the package version. Master includes unreleased async runner consistency work after the Knip freeze fix: jscpd/Madge/formatters/dispatch runners now use async subprocess execution in hook paths, with in-flight guards for expensive scans. CI runs `npm ci` + tsc lint + vitest.

## Conventions
- TypeScript ESM throughout (`"type": "module"`)
- Edit the `.ts` sources only. Do **not** hand-edit sibling/generated `.js` files in this repo; pi loads TS via on-the-fly jiti transpilation and JS files are generated artifacts. If tests/runtime could see stale `.js`, run `npm run build` to regenerate from TS before testing.
- Tests use vitest; mocks via `vi.mock` / `vi.hoisted`
- Fire-and-forget background work uses `void expr` or `setImmediate`
- `logSessionStart()` is a no-op in test mode (`VITEST` env var)
- LSP tool: use `goToDefinition` / `findReferences` before grepping for symbols
