# pi-lens — agent context

## What it is
A pi coding-agent extension that runs automated checks on every file write/edit. Dispatches async parallel runners (LSP, biome, ruff, ast-grep, tree-sitter, type coverage, jscpd, knip, Madge, and language-specific linters/build checks) and injects findings as context injections at turn-end and session-start.

## Key source layout
```
index.ts                  Extension entry point (async factory)
clients/
  runtime-session.ts      session_start handler — snapshot hydrate, tool preinstall, background scans, LSP warm
  project-snapshot.ts     Versioned seq-stamped project snapshot cache
  project-changes.ts      Append-only project/file sequence change log
  reverse-deps.ts         Snapshot-backed reverse dependency index/query helpers
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

## Data directory conventions

**All project-scoped persistent data must go through `getProjectDataDir(cwd)`** (`clients/file-utils.ts`).

```typescript
import { getProjectDataDir } from "./file-utils.js";
const cacheFile = path.join(getProjectDataDir(cwd), "cache", "my-file.json");
```

`getProjectDataDir` respects `PILENS_DATA_DIR`:
- If `PILENS_DATA_DIR` is set → `$PILENS_DATA_DIR/<project-slug>/`
- Otherwise, if `<cwd>/.pi-lens/` already exists → use it (legacy)
- Default → `~/.pi-lens/projects/<project-slug>/`

**Project-scoped** (must use `getProjectDataDir`): caches, snapshots, indexes, worklogs, change-log, code-quality-warnings, actionable-warning-state, review-graph, semgrep config, install-choices.

**Machine-global** (intentionally hardcoded to `~/.pi-lens/`): latency.log, cascade.log, tree-sitter.log, sessionstart.log, read-guard.log, actionable-warnings.log, tools/, bin/, intelephense/, logs/. These are shared across all projects.

Never write `path.join(cwd, ".pi-lens", ...)` for a project cache — it breaks when `PILENS_DATA_DIR` is set.

## Debug logs
- `~/.pi-lens/sessionstart.log` — timestamped lines for every session_start event and tool lifecycle; includes project snapshot probe/miss/load summaries, seeded project/file sequence counts, scan-context/profile cache source, and deferred task queued/run timings
- `~/.pi-lens/cascade.log` — NDJSON cascade graph/neighbor diagnostics, including reverse-dependency cache refresh/load/merge events (`phase: "reverse_deps_cache"`)
- `~/.pi-lens/latency.log` — NDJSON per-runner timings
- `~/.pi-lens/read-guard.log` — NDJSON for every read-guard verdict, autopatch, and preflight block (rotates at 1 MiB); key events: `edit_blocked`, `edit_warned`, `edit_preflight_blocked`, `oldtext_not_found`, `oldtext_trailing_ws_autopatched`, `oldtext_indent_autopatched`, `oldtext_escape_autopatched`
- `~/.pi-lens/actionable-warnings.log` — NDJSON for the actionable-warnings advisory pipeline (rotates at 1 MiB); events: `report_started`, `lsp_file_checked`, `lsp_file_skipped`, `report_complete`, `advisory_injected`, `advisory_skipped`
- `~/.pi-lens/probe-cache.json` — tool binary path cache (TTL 24h)
- `.pi-lens/cache/` — knip, jscpd, todo-baseline, turn-end-findings, actionable-warnings, code-quality-warnings, and project-snapshot caches
- `.pi-lens/cache/project-snapshot.json` / `.pi-lens/cache/project-snapshot.meta.json` — versioned seq-stamped project snapshot; preserves cached exports, project rules, startup scan/profile metadata, and reverse dependency data
- `<project-data-dir>/change-log.jsonl` — append-only observed mutation log with project/file sequence numbers
- `<project-data-dir>/code-quality-warnings.jsonl` — append-only code-quality advisory history

## Lifecycle and pipeline flow

Four hooks in `index.ts` drive everything:

**`session_start`** → `handleSessionStart` (`clients/runtime-session.ts`)
Resets `RuntimeCoordinator` and fast-resets any old LSP service with `resetLSPService({ fast: true })`. Seeds project/file sequence state from `project-changes.ts`, probes `.pi-lens/cache/project-snapshot.json`, and hydrates cached exports/project rules/startup scan/profile metadata when the snapshot seq matches the current project seq. Fires tool preinstall (typescript-language-server, biome, etc.) and background scans (knip, jscpd, ast-grep exports, project index) as deferred fire-and-forget tasks via `setImmediate`; task logs split queued vs run time. LSP config walk is also deferred via `setImmediate`. Returns in ~150ms on warm runs; background tasks finish asynchronously. Knip/jscpd startup scans are async and guarded against duplicate in-flight scans.

**`tool_call`** (write/edit events) → inline handler in `index.ts`
Warms the LSP for the file and records read-guard lines. For write/edit tools, runs the read-guard autopatch pipeline (Passes 0–2) before the edit lands, then records preflight data for the later `tool_result` dispatch.

**`tool_result`** → `handleToolResult` (`clients/runtime-tool-result.ts`)
Tracks modified file ranges per turn for turn_end targeting, bumps project/file sequence state for observed writes/edits, and appends project changes to `change-log.jsonl`. For write/edit events, runs the dispatch pipeline: format → autofix → LSP diagnostics sync → parallel async runner dispatch → dedup/merge → findings stored on `RuntimeCoordinator`. Pipeline crash recovery fast-resets LSP with `resetLSPService({ fast: true })`.

**`turn_end`** → `handleTurnEnd` (`clients/runtime-turn.ts`)
Merges unresolved inline blockers and cascade findings, writes latest-turn actionable/code-quality warning reports with sequence metadata, runs Knip delta analysis when the startup scan is not in flight, runs Madge circular-dependency checks for files whose imports changed, and fires related/failed tests asynchronously for the next context injection. Deduplicates findings against previous turn state and injects blockers (🔴) and advisories into the agent's context.

## Key abstractions

**`RuntimeCoordinator`** (`clients/runtime-coordinator.ts`) — session-scoped singleton passed through most of the stack.
Key fields: `projectRoot`, `sessionGeneration` (incremented on each `session_start`), `projectSeq`, `turnStartProjectSeq`, file sequence map (`bumpFileSeq()`, `getFileSeq()`), `cachedExports` (symbol→file map from ast-grep startup scan), `cachedProjectIndex` (structural similarity index), `complexityBaselines` (per-file complexity for regression detection), `projectRulesScan` (custom ast-grep rules found in the project), per-turn actionable warnings, and per-turn code-quality warnings.

**`DispatchContext`** — built per dispatch by `createDispatchContext()` in `clients/dispatch/dispatcher.ts`.
Holds: `filePath`, language-root `cwd`, `kind` (`FileKind` — `jsts`, `python`, `go`, `rust`, `css`, etc.), `pi` flags, `facts` (FactStore), `blockingOnly`, `modifiedRanges`, and `hasTool(cmd)` / `log()` helpers.

**`FactStore`** — session+turn-scoped key-value store. Runners use it to cache tool availability checks (e.g., "is biome installed?") so subsequent dispatches within the same session skip the spawn. Set/get via `facts.setSessionFact` / `facts.getSessionFact`.

**`FileKind`** — union type (`"jsts"` | `"python"` | `"go"` | `"rust"` | …) detected from the file path. Controls which runners are eligible for a given dispatch. Runners declare `appliesTo: FileKind[]`; an empty array means "all kinds".

## Project intelligence and snapshots
- `RuntimeCoordinator` owns monotonic `projectSeq` and per-file sequence numbers. Every pi-observed disk mutation should call `bumpFileSeq()` and append a `ProjectChangeEntry` via `appendProjectChange()` with source `agent-write`, `agent-edit`, `partial-apply`, `format`, `autofix`, `lsp-edit`, or `external`.
- `clients/project-changes.ts` persists `<project-data-dir>/change-log.jsonl` and seeds session-start sequence state with `readLatestProjectSequence()`.
- `clients/project-snapshot.ts` saves `.pi-lens/cache/project-snapshot.json` with `version`, `seq`, `cachedExports`, `projectRulesScan`, startup scan/profile metadata, and reverse dependency data. Freshness is seq-based: `snapshot.seq === runtime.projectSeq`.
- `clients/reverse-deps.ts` builds `file -> imports` and `file -> importedBy` from the review graph, persists them into the project snapshot, reloads fresh snapshot-backed indexes, and provides bounded affected-file queries. Cascade graph builds refresh this section and merge fresh cached reverse-dependency neighbors into cascade selection; debug via `~/.pi-lens/cascade.log` phase `reverse_deps_cache`.
- `actionable-warnings.json`, `code-quality-warnings.json`, code-quality history, and turn-end findings include project/file sequence metadata. Agent-end actionable-warning autofix must reject stale reports before applying cached LSP quickfixes.

## Session-start critical path
`lsp-config` is deferred via `setImmediate` (not awaited). Startup background task bodies are deferred via `setImmediate` so sync scans cannot inflate the interactive path; logs report both queued and run time. Tool availability probes use the probe cache before spawning binaries. Interactive path target: ~150ms on warm runs.

## Runner process model
- Prefer `safeSpawnAsync()` for all subprocess work in hook paths (`session_start`, write/edit `tool_result`, `turn_end`, formatter pipeline, and dispatch runners). `safeSpawn()` is deprecated and blocks the Node event loop.
- Expensive project scans have in-flight guards: Knip by project root, jscpd by project root + scan params, Madge by project root/file or project root scan.
- Check cheap filesystem/root preconditions before availability probes or auto-install. Example: Knip/jscpd/Madge skip non-project or empty roots before probing/installing tools.
- `createAvailabilityChecker()` now exposes `isAvailableAsync()`; use it in runners. The sync `isAvailable()` remains only for legacy/test compatibility.
- Formatter execution (`clients/formatters.ts::formatFile`) uses `safeSpawnAsync()` so timeout wrappers are meaningful.
- Session replacement, session shutdown, and pipeline crash recovery use fast LSP teardown (`resetLSPService({ fast: true })` / `client.shutdown({ fast: true })`) to skip protocol handshakes and unref process/timer handles.
- Long-lived debounce timers should call `.unref()` where safe (probe-cache flush, metrics-history save, LSP idle reset) so teardown/short-lived runs are not held open just for best-effort background writes.

## Read-guard autopatch pipeline

Runs in the `edit` PreToolUse handler (`index.ts`) before the edit tool executes. Mutates `e.oldText` in-place and logs a structured event for each correction applied.

| Pass | What it fixes | Event logged |
|------|--------------|--------------|
| 0 | Literal `\n`/`\t` escape sequences vs actual newline/tab in `oldText` | `oldtext_escape_autopatched` |
| 1 | Trailing whitespace per line **and** trailing empty lines (e.g. model appends `\n\t\t\t\t` from the next line's indent) | `oldtext_trailing_ws_autopatched` |
| 2a | Fixed tab↔space conversions (tabs→2sp, tabs→4sp, 2sp→tabs, 4sp→tabs) | `oldtext_indent_autopatched` |
| 2b | `findIndentationInsensitiveCandidate` — strips all leading whitespace, matches on content only, returns actual file lines; handles arbitrary indentation depth mismatches | `oldtext_indent_autopatched` |

**Safety gates (all must hold for a patch to apply):**
- Stripped/corrected form differs from the original
- `countOldTextMatches === 1` on the corrected form (no ambiguity)
- Pass 2: `isIndentationOnlyChange === true` (every line's `.trim()` content is identical) and `currentMatchCount === 0` (original doesn't already match)

**Known gaps (fix when seen in logs):** internal whitespace differences (e.g. `foo  =  bar` vs `foo = bar`) and missing/extra blank lines within a block are not handled. Add a new pass if either pattern appears as repeated `oldtext_not_found` events.

**`out_of_range` downgrade:** when all `oldText` strings in an edit were resolved (content-match proof, flagged as `oldTextResolved`), an out-of-range verdict is downgraded from `block` to `warn`. Line drift from earlier inserts is the common cause; the model demonstrably knew the content.

**Repeat-failure escalation:** `REPEAT_FAILURE_TTL_MS` is 300 s (inter-turn delays routinely exceed 30 s). At ≥ 2 failures within that window the preflight error header escalates from `🔄 RETRYABLE` to `🛑 RE-READ REQUIRED`.

## Internal edit substrate direction

Phase 6 in `implementation.md` is intentionally **not** a public `lens_edit` tool. It should be an internal mutation substrate to reduce failed edits in pi-lens-owned paths while preserving the native agent edit lifecycle:

```text
Native agent edit/write path:
read expansion → read guard → oldText autopatch → native edit → tool_result pipeline

pi-lens-owned mutation path:
seq/hash/range validation → atomic apply → read-guard stamp → seq/change-log → normal post-edit pipeline
```

Use it first for partial apply, then LSP workspace edits/actionable autofix. It must not bypass read guard for normal agent edits, replace oldText autopatch, guess stale ranges, or apply project-wide edits by default.

## Open design TODOs

- **LSP server preference via project config** — `clients/lsp/config.ts` supports `.pi-lens/lsp.json` with `disabledServers` and custom server entries, but there is no way to express a *preference* between built-in candidates (e.g. prefer `basedpyright` over `pyright` when both are installed). `PythonServer.spawn()` currently uses first-found-wins ordering (`pyright-langserver` before `basedpyright-langserver`). A future `preferredServer` key in `LSPConfig` should let projects override this ordering; the server policy layer (`clients/lsp/server-policy.ts`) is the right place to apply the preference before candidate resolution.

## Legacy async-cleanup TODO
- Migrate remaining `runner-helpers.ts` sync compatibility paths (`isAvailable()`, `isSgAvailable()`, `resolveLocalFirst()`) to async callers, then remove or clearly quarantine the sync APIs.
- Add async `sg` availability/command resolution and migrate `python-slop`/other sg CLI consumers away from sync `isSgAvailable()` probes.
- Convert remaining formatter detection/install helper probes in `clients/formatters.ts` (e.g. rubocop gem install, rustfmt install, Go env checks, csharpier probes) from `safeSpawn()` to `safeSpawnAsync()` or installer-managed async helpers.
- Audit explicit command flows such as `/lens-booboo` for remaining full-project `safeSpawn()` calls; they are lower priority than hook paths but should not freeze the TUI.
- Keep tests mocking both `safeSpawn` and `safeSpawnAsync` where legacy compatibility remains; prefer async mocks for new runner tests.

## Actionable warnings routing

Every dispatch warning passes through one of two recorders in `clients/pipeline.ts`:

| Recorder | Required diagnostic fields | Destination |
|---|---|---|
| `recordFromDispatchDiagnostic` | `semantic === "warning"` AND `severity === "warning"` AND (`fixable` OR `fixSuggestion`) | `actionable-warnings.json` — surfaces an advisory and can drive autofix |
| `recordFromCodeQualityDiagnostic` | `semantic === "warning"` or `"none"` AND `severity !== "error"` AND (no fixable, no fixSuggestion, no autoFixAvailable) | `code-quality-warnings.json` — informational history only |

A runner that wraps a tool with an auto-fix capability **must** propagate `fixable: true` or `fixSuggestion: "<rule-specific guidance>"` per diagnostic — otherwise everything it produces silently goes to code-quality and never reaches the actionable advisory. Severity-`error` diagnostics route to blockers instead, regardless of fixability.

Patterns by tool capability:
- **Tool exposes per-diagnostic fix metadata** (biome, eslint, ruff, rubocop, shellcheck, semgrep, oxlint via `--format json` + `help`, ast-grep, tree-sitter via `has_fix`): read it directly, set `fixable: !!fix` or `fixSuggestion: help`.
- **Tool has `--fix` but no per-warning fix flag** (stylelint, markdownlint): static allowlist of rule IDs documented as deterministically fixable. False positives are worse than false negatives — keep the list conservative.
- **Tool has no auto-fix** (cpp-check, phpstan, javac, pyright, mypy, go-vet, actionlint, yamllint, etc.): hard-code `fixable: false`. The diagnostic correctly lands in code-quality.

When changing a serialized cache that feeds this pipeline (e.g. `clients/cache/rule-cache.ts`), bump `CACHE_VERSION` so old entries invalidate. The tree-sitter rule cache previously stripped `has_fix` on roundtrip, silently demoting every tree-sitter rule with auto-fix to non-fixable on any cache hit (commit `24af518`).

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
v3.8.45 is the package version. Master includes unreleased work: read-guard autopatch improvements (trailing empty lines, `out_of_range` downgrade, repeat-failure escalation), actionable/code-quality warning reports with sequence metadata, project/file sequencing plus append-only change logs, project snapshot hydration, reverse-dependency snapshot cache/query helpers, structured NDJSON telemetry for the actionable-warnings pipeline (`actionable-warnings-logger.ts`), and async/fast lifecycle consistency (jscpd/Madge/formatters use `safeSpawnAsync`; LSP teardown uses fast/unref paths). CI runs `npm ci` + tsc lint + vitest.

## Conventions
- TypeScript ESM throughout (`"type": "module"`)
- Edit the `.ts` sources only. Do **not** hand-edit sibling/generated `.js` files in this repo; pi loads TS via on-the-fly jiti transpilation and JS files are generated artifacts. If tests/runtime could see stale `.js`, run `npm run build` to regenerate from TS before testing.
- Tests use vitest; mocks via `vi.mock` / `vi.hoisted`
- Fire-and-forget background work uses `void expr` or `setImmediate`
- `logSessionStart()` is a no-op in test mode (`VITEST` env var)
- LSP tool: use `goToDefinition` / `findReferences` before grepping for symbols
- `clients/runtime-config.ts` is "pure constants" by intent. Resolutions that read disk or env (e.g. `getRunnerTimeoutFloorMs`) must be **lazy memoized getters** with a `_resetForTests` hook, not module-level reads, so importing the file has no I/O side effect and tests can override inputs deterministically.
- Numeric inputs from env vars or JSON config that flow into `Math.max` / `Math.min` must be coerced through a `Number.isFinite(n) && n > 0` guard. `Number(undefined) === NaN`, and a single NaN argument makes `Math.max` return NaN, which `setTimeout` silently treats as 0.
