# pi-lens — agent context

## Maintaining this file (do this on every commit)
AGENTS.md is the durable context handed to every agent that works on pi-lens. **Update it as part of the same commit that changes the world it describes** — never as a follow-up:
- **Kill staleness.** If a commit changes behavior, structure, commands, conventions, or invariants documented here, fix the affected lines now. A stale claim is worse than none — agents act on it as fact.
- **Capture decisions & patterns.** When a commit establishes a non-obvious decision, gotcha, convention, or architectural pattern the next agent would otherwise relearn the hard way, add it here with the *why* and *how-to-apply* (recent examples: the dist/packaging + `pi.skills` resolution gotcha, the event-loop/hot-path discipline, the build-vs-lint gate).
- **Keep it high-signal.** Prune what's no longer true; prefer concise, load-bearing notes over exhaustive prose.

## What it is
A pi coding-agent extension that runs automated checks on every file write/edit. Dispatches async parallel runners (LSP, biome, ruff, ast-grep, tree-sitter, type coverage, jscpd, knip, Madge, and language-specific linters/build checks) and injects findings as context injections at turn-end and session-start.

## Key source layout
```
index.ts                  Extension entry point (async factory) — the pi host adapter
mcp/                      Second host adapter: MCP server + hook bin (see "MCP mirror")
  server.ts               Hand-rolled stdio JSON-RPC MCP server (14 tools) + warm IPC listener
  worker.ts               fresh-mode child (loads freshly-built code from disk)
  analyze-cli.ts          pi-lens-analyze bin — PostToolUse hook + CLI (warm channel → cold fallback)
clients/
  lens-engine.ts          THE internal seam — host adapters import only this for pi-lens functionality
  mcp/                     host-neutral facades: analyze, session, review, ipc, host-shim
  runtime-session.ts      session_start handler — snapshot hydrate, tool preinstall, background scans, LSP warm
  project-snapshot.ts     Versioned seq-stamped project snapshot cache
  project-changes.ts      Append-only project/file sequence change log
  reverse-deps.ts         Snapshot-backed reverse dependency index/query helpers
  word-index.ts           Identifier inverted index + BM25 ranking (#162) — built in the session scan, persisted in the snapshot; consumed ONLY by the pilens_symbol_search MCP tool (not yet by pi-lens internals)
  review-graph/query.ts   Graph queries incl computeImpactCascade (one-hop, used by the cascade) + computeTransitiveImpact (depth-bounded BFS, used ONLY by pilens_impact)
  installer/index.ts      Auto-install + ensureTool; probe-cache.json for fast restarts. Strategies: npm/pip/gem/github + maven (fat JAR from Maven Central → java -jar launcher in ~/.pi-lens/bin, gated on a JRE; e.g. ktfmt)
  lsp/                    37 LSP server IDs (incl. opengrep, a cross-cutting AUXILIARY diagnostic LSP — role:"auxiliary", #111), config, lifecycle
  dispatch/               Pipeline dispatcher + 47 registered runners (incl. spotbugs — flag-gated via withSpotbugsGroup, #133). Auxiliary LSPs (opengrep, …) are NOT runners — they attach via the lsp runner's with-auxiliary path; see clients/dispatch/auxiliary-lsp.ts
  widget-state.ts         Footer widget rendering (@earendil-works/pi-tui)
tools/                    ast-grep-search, lsp-navigation tool handlers
tests/                    Vitest test suite (mirrors clients/ structure)
```

## MCP mirror (second host adapter — `mcp/` + `clients/lens-engine.ts`)

pi-lens is also exposed as an **MCP server** so it can be used / live-tested /
debugged directly in Claude Code (or any MCP client) without running pi. This is
a *second host adapter* alongside `index.ts`. Design rationale + progress: `mcp.md`.

- **The seam discipline (the maintainability invariant).** Host adapters talk to
  **`clients/lens-engine.ts` only** — never reach into pi-lens internals from
  `mcp/server.ts`. A new mirrored capability = **one engine method + one tool
  route**; the engine is the single place coupled to internals, so a refactor
  breaks there (TypeScript-loud), not across the adapter. `clients/mcp/*` are the
  host-neutral facades the engine composes (they're misnamed "mcp" — they're not
  MCP-specific). The whole host coupling of the dispatch core is **one method**,
  `PiAgentAPI.getFlag` (`clients/mcp/host-shim.ts` → `createMcpHost`).
- **Transport is hand-rolled, zero-dep** (newline-delimited JSON-RPC). NO MCP SDK:
  `npm install --omit=dev` does **not** omit `optionalDependencies` (only
  `--omit=optional` does, which pi doesn't pass), so even an "optional" SDK would
  weigh every pi-lens install. ~200 LOC beats a dep for a tools-only server.
- **14 tools:** `pilens_analyze` (per-edit; `mode: warm|fresh`), `pilens_diagnostics`,
  `pilens_project_scan`, `pilens_latency`, `pilens_health`, `pilens_rebuild`,
  `pilens_session_start` / `pilens_turn_end` (drive the REAL lifecycle handlers —
  not re-implementations — via `clients/mcp/session.ts`), `pilens_ast_grep_search`
  / `pilens_ast_grep_replace`, `pilens_lsp_navigation` / `pilens_lsp_diagnostics`,
  `pilens_symbol_search` (ranked identifier search over the persisted word index —
  BM25 + priors + reverse-dep centrality), `pilens_impact` (transitive review-graph
  dependents — blast radius). Wrapped pi tools emit their typebox `parameters` as
  the MCP `inputSchema` (via `schemaWithCwd`) — no hand-restated schema to drift.
- **MCP-only vs pi-lens-internal (a real gap to close, not a finished story).**
  `pilens_symbol_search` and `pilens_impact` are currently **agent-facing queries
  only**: the word index is built during pi-lens's own session scan (pi pays the
  cost) but nothing in pi-lens consumes it, and `pilens_impact` uses *transitive*
  BFS (`computeTransitiveImpact`) while the in-pi **cascade still derives neighbors
  one-hop** (`computeImpactCascade` in `dispatch/integration.ts`). The higher-value
  move is to feed the transitive impact (bounded depth/budget) into cascade neighbor
  derivation — ideally paired with the #202 structural-hash short-circuit so the
  expansion is *pruned* when a changed file's exported interface is unchanged. When
  adding a capability via the engine, ask whether pi-lens itself should use it, not
  just the mirror.
- **warm vs fresh review loop.** The server is long-lived (warm LSP, cached code);
  `fresh` forks a worker that loads freshly-built code from disk → reflects the
  latest commit. `pilens_rebuild` closes it: commit → rebuild → `mode=fresh`.
  **`fresh` always cold-spawns the LSP, so it under-reports LSP on large projects
  within any per-call budget** — surfaced honestly via the `lsp` signal, never a
  silent "clean" 0. warm + an indexed server is the LSP-complete path.
- **Push half = the `pi-lens-analyze` bin** wired as a Claude Code `PostToolUse`
  (Edit|Write) hook. MCP is pull; the hook is the only way to auto-fire on edit.
  It tries the **warm IPC side-channel first** (`clients/mcp/ipc.ts`: Unix socket /
  Windows named pipe, hashed per workspace) → analysis runs in the warm server
  (LSP-complete) and the bin never loads the dispatch graph; falls back to cold
  no-LSP local analysis. `pilens_analyze` (warm) + the hook auto-register edited
  files into turn-state (`addModifiedRange`) so `pilens_turn_end` needs no file list.
- **Auto session on connect:** `PI_LENS_MCP_AUTO_SESSION=1` runs `session_start`
  when the server boots (a Claude `SessionStart` hook can't warm the server's
  in-process LSP — separate process). Register: `claude mcp add --scope user
  pi-lens -e PI_LENS_MCP_AUTO_SESSION=1 -- node <repo>/dist/mcp/server.js`.
- **The bin target is `dist/`.** After changing MCP/engine/runner code, run
  `npm run build:dist` so the user-scoped server (`dist/mcp/server.js`) picks it up
  on the next Claude session. (`bin`: `pi-lens-mcp`, `pi-lens-analyze`.)
- **Dogfooding found two dormant pi features** (fixed/flagged, not the MCP's fault):
  the cold-LSP-returns-0 honesty bug (`runners/lsp.ts` — `touched === undefined`
  now → `skipped`, not a false `succeeded`), and **`runtime.errorDebtBaseline` is
  never set in production** (the green→red/error-debt machinery is dead plumbing).
  Before mirroring a pi capability, check it's actually live.
- Tests: `tests/clients/mcp/*` (units) + `tests/mcp/*` (spawn smokes — real server
  + bin end-to-end). Live behaviors (warm IPC, real session/turn) are unit-covered;
  the spawn smokes don't exercise them.

## Package scope
All pi packages are `@earendil-works/*` (migrated from `@mariozechner/*` in 0.74.0). Peer dep: `@earendil-works/pi-coding-agent`. Runtime dep: `@earendil-works/pi-tui`.

## Commands
```
npm test              # vitest run (all tests)
npx tsc --project tsconfig.json --noEmit   # type-check
npm run lint          # same as type-check
npm run build         # emit JS from TS; run before tests after source changes if stale JS may be present
node scripts/smoke-tools.mjs [--install] [--step2] [--verbose] [lang ...]   # live tool-smoke (#209, opt-in/nightly): installs + runs each tool through the REAL dispatch path against tests/fixtures/tool-smoke/<lang>/; --step2 also asserts a parseable diagnostic. Add --lsp for the LSP-handshake layer, --format for the formatter pipeline, or --autofix for the pipeline safe-autofix phase. Not a per-PR gate, not shipped in the tarball.
#   --format drives getFormattersForFile→formatFile via FormatService (what runFormatPhase uses; the lint path NEVER runs formatters): asserts the expected formatter is selected (config-gated ones ship the config their detect() needs — .prettierrc/gleam.toml/Gemfile/pyproject[tool.black]/stylua.toml/.cljfmt.edn/.php-cs-fixer.php/.editorconfig) and that it actually reformats a mis-formatted fixture (changed===true). Covers 28/31 formatters (tests/fixtures/format-smoke/<lang>/); only nixfmt/ocamlformat/swiftformat remain (no Windows toolchain). Plain-command formatters (stylua/cljfmt/php-cs-fixer/google-java-format/clang-format) need their binary ON PATH or formatFile reports changed=false; managed-dir ones (taplo/shfmt/ktlint) don't.
#   --autofix drives runAutofix (the pipeline phase that applies fixable linters in --fix mode — distinct from lint-only dispatch AND from formatters; it MUTATES files): asserts the policy-selected tool applied a fix (fixedCount>0). Live-validates 11 (ruff/biome/rubocop/sqlfluff/rust-clippy/dart-analyze/stylelint/eslint/golangci-lint/markdownlint/oxlint in tests/fixtures/autofix-smoke/<lang>/); ktlint blocked by #218; detekt wired but CI-deferred (needs detekt CLI+formatting plugin). Workspaces are git-init'd so VCS-gated fixers (cargo fix) run. Autofix gating MIRRORS each tool's lint-policy strategy (config-first: eslint/oxlint/golangci-lint/detekt; smart-default: the rest) — guarded by tests/clients/autofix-policy-consistency.test.ts (autofix policy ↔ AUTOFIX_CAPABILITIES ↔ lint policy gates).
#   Lint covers ts/py/yaml/js/markdown/shell/css/html/toml/sql/dockerfile/terraform + toolchain-gated go/rust/csharp/powershell/zig/java/dart/php/ruby/kotlin/gleam/elixir (toolchain must be installed locally; CI nightly sets them up).
curl -s "https://sonarcloud.io/api/hotspots/search?projectKey=apmantza_pi-lens&branch=master&status=TO_REVIEW&ps=100"   # list open SonarCloud security hotspots (public API, no auth). Triage: real fix vs mark-Safe (this project has had S5852 ReDoS false-positives on trusted bounded tool output).
npm run logs:smells   # scripts/analyze-pi-lens-logs.mjs — scans ~/.pi-lens/*.log for operational smells (diagnostic-blockers, slow-hook-path ≥5s, slow-runners ≥2.5s, cascade-slow-graphs ≥1s, lsp-availability-noise, read-guard-friction). Flags: --since 3d (default 2d), --limit, --json. READ CRITICALLY: much volume is user-project diagnostics (not pi-lens bugs) + self-noise from temp:pi-lens-smoke-* (my own --install cold-tool runs). Real pi-lens smells: cascade-slow-graphs + slow-hook-path (cold LSP + cascade hot-path).
```

Because many test imports use `.js` specifiers while the source of truth is `.ts`, recompile after TS changes before running tests when local `.js` artifacts may exist/stale:
```
npm run build && npm test
```
**This is now enforced (#198):** a vitest `globalSetup` (`tests/support/check-build-freshness.ts`) fails fast — for *any* launch (`npm test`, `npx vitest run`, watch start) — if a compiled-source `.ts` under `clients/`/`commands/`/`tools/` (or root `index.ts`/`i18n.ts`) is newer than its in-place `.js` (or has none). If you see `⛔ Stale build …`, run `npm run build` and re-run. (CI's `test` job builds first, so it passes.)
Do not hand-edit generated `.js`; regenerate it from the corresponding `.ts`. This includes `scripts/download-grammars.js`, which is the runtime/postinstall artifact generated from `scripts/download-grammars.ts` and must stay in sync for published installs.

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

**Project-scoped** (must use `getProjectDataDir`): caches, snapshots, indexes, worklogs, change-log, code-quality-warnings, actionable-warning-state, review-graph, install-choices.

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
- **LSP last-known cache is content-hash guarded (anti-staleness).** `LensLSPService.touchFile` primes `lastKnownDiagnostics` together with a sha256 of the synced content; `getLastKnownDiagnostics(path, expectedContentHash)` returns the entry *only* if that hash matches the current bytes. The actionable-warnings turn_end read passes the hash of the on-disk file, so a previous turn's diagnostics are never reused as current — on mismatch (or an entry written without content, e.g. the service-level merge, which clears the hash) it falls through to a fresh open+wait. Any NEW hot-path consumer that reuses last-known diagnostics as authoritative MUST pass the content hash; omit it only for display (the widget). `lspSource:"cache"` in `actionable-warnings.log` now means *verified-current reuse*, not "maybe stale".

## Session-start critical path
`lsp-config` is deferred via `setImmediate` (not awaited). Startup background task bodies are deferred via `setImmediate` so sync scans cannot inflate the interactive path; logs report both queued and run time. Tool availability probes use the probe cache before spawning binaries. Interactive path target: ~150ms on warm runs.

## Runner process model
- **Use `safeSpawnAsync()` for all subprocess work** in hook/dispatch/install paths. The sync `safeSpawn()` is deprecated, blocks the Node event loop, and (as of #197) is reachable only from `commands/booboo.ts` (user-invoked `/lens-booboo`, where blocking is acceptable) and the cached `TestRunnerClient.detectRunner` `which pytest` probe. Don't add new sync `safeSpawn` callers.
- **The hot per-edit path is the dispatch runners** (`clients/dispatch/runners/*`), not the legacy per-tool client classes (`biome-client`, `ruff-client`, `rust-client`, `ast-grep-client`, …). Those classes historically carried a *parallel sync surface* (`checkFile`/`fixFile`/`isAvailable`/`findCargoPath`/…) that the async runners superseded; #197 found almost all of it **dead** and deleted ~1600 lines. **Lesson: when you find a sync client method, grep its real callers before "converting" it — the answer is usually "delete," and the live path already has an `*Async` twin** (`fixFileAsync`, `ensureAvailable`, `runTestFileAsync`, `tempScanAsync`, `findGoPathAsync`).
- **Ambient turn abort signal (#197):** `safeSpawnAsync` defaults its `AbortSignal` to a module-level ambient signal (`setAmbientAbortSignal` in `clients/safe-spawn.ts`). The lifecycle handlers (`tool_result`, `agent_end`, `turn_end`) publish pi's `ctx.signal` at entry and clear it in `finally`, so an Esc/interrupt kills in-flight linter/format/type-check children (process-tree kill on Windows) without threading a signal through every call site. The signal is captured at spawn time, so clearing it only affects future spawns. Pass `ignoreAmbientSignal: true` for **installs** (gem/go/dotnet/rustup) so they run to completion even if the turn is interrupted — matching the old uncancellable sync behaviour; an explicit `options.signal` always wins.
- Expensive project scans have in-flight guards: Knip by project root, jscpd by project root + scan params, Madge by project root/file or project root scan.
- Check cheap filesystem/root preconditions before availability probes or auto-install. Example: Knip/jscpd/Madge skip non-project or empty roots before probing/installing tools.
- `createAvailabilityChecker()` is **async-only** — returns `{ isAvailableAsync, getCommand }` (cached per-cwd, in-flight-deduped). The sync `isAvailable()` and its `?? x.isAvailable(cwd)` runner fallbacks were removed (#197); runners call `await x.isAvailableAsync(cwd)`. Per-client availability/path probes follow the same `*Async` convention (`RustClient.findCargoPathAsync`/`isAvailableAsync`, `GoClient.findGoPathAsync`/`isGoAvailableAsync`, `TypeCoverageClient.isAvailableAsync`/`scanAsync`, `SgRunner.tempScanAsync`/`exec`, ast-grep `ensureAvailable`).
- Formatter execution and lazy installs (`clients/formatters.ts`) and the LSP runtime installs (`clients/lsp/server.ts` `tryGoInstallGopls`/`tryDotnetToolInstall`/`tryGemInstall`) all use `safeSpawnAsync`. **Windows note:** prefer `safeSpawnAsync` over raw `spawnSync(…, {shell:false})` for tool launches — `gem`/`dotnet`/`biome` are often `.cmd` shims that only run under shell mode (which `safeSpawnAsync` uses), and it also gives UTF-8 (`chcp 65001`) + `taskkill /F /T` tree-kill. The host SDK's `pi.exec` is **not** a substitute (no Windows UTF-8/tree-kill/batch/`which`).
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

## Read-guard: non-Read sources of "the agent saw / authored this"

The guard tracks more than the Read/Write/Edit tools. All of these register so a follow-up edit isn't falsely blocked:

- **bash file VIEWS** (`clients/bash-file-access.ts` → `extractReadPathsFromCommand`): `cat`/`less`/`more`/`bat`/`nl` (full file), `head -N`/`tail -N` (the shown N lines), `sed -n 'A,Bp'` (lines A–B). Registered at tool_call via `recordRead` with the **exact line range** (the guard enforces ranges). `ls`/`find` are NOT views (name-only, reveal no editable content) — never registered, and registering them would falsely mark a file "read". `grep` is not a contiguous view but IS registered via the search path below.
- **bash WRITES** (`extractWrittenPathsFromCommand`): `>`/`>>`/`N>`, `tee`, `sed -i`, `cp`/`mv` dest, `touch`. The agent authored the file, so — exactly like the Write tool — `noteCreatedFile` at tool_call + `recordWritten` at tool_result.
- **search tools** (`clients/search-read-registration.ts` → `registerSearchReads`, ±2-line context margin): a tool exposes the lines it revealed via `details.searchReads: {file, startLine(1-based), endLine}[]`; `handleToolResult` consumes that for **any** tool and registers reads of only those lines (never the whole file). Populated by `ast_grep_search` (#169, done) and bash `grep -n`/`egrep`/`fgrep` (output parsed via `extractGrepSearchReadsFromOutput`). **Still remaining:** the pi built-in `grep`/`glob` tool and `lsp_navigation` (both reveal an editable span — wire them for parity; `ls`/`glob`/`find` stay excluded as name-only). New producers only need to populate `details.searchReads` — no hook change.

**PATH-KEY INVARIANT (hard-won — #210):** `ReadGuard` keys its `reads`/`edits`/`exemptions`/`pendingCreations`/`writtenThisSession` maps through `normalizeFilePath` (private `key()`), never the raw path. Read sources arrive with mixed separators/casing — the Read tool gives OS-native backslashes on Windows; search/LSP reads arrive slash-normalized from URIs — and `resolveToolCallFilePath` returns absolute paths verbatim. Keying on the raw string made a read recorded under one form invisible to an edit checked under another → false `zero_read` block despite the file having been read. **Any new map access MUST key through `key()`, and any new read-guard test MUST exercise cross-separator paths** (record one form, check the other) — same-form-on-both-sides is exactly what let #210 ship. Guarded by `tests/clients/read-guard-path-normalization.test.ts`.

## Dependencies & install constraints (hard-won — see #167-area fixes)

pi installs git extensions with **`npm install --omit=dev`** (and omits peers). Consequences that MUST be respected:

- **Runtime imports must live in `dependencies`, never `devDependencies`.** A runtime import of a dev-only package fails to load at user sites (`Cannot find package …`). Example bug: `js-yaml` was dev-only but imported at runtime.
- **The host SDK `@earendil-works/pi-coding-agent` must be imported TYPE-ONLY.** It is not present at runtime under `--omit=dev`, and pulling it in (as a runtime import or non-optional dep) drags a huge tree (`@mistralai/…`) with paths exceeding Windows `MAX_PATH`, which breaks `git clean -fdx` on `pi update`. Runtime helper needed from it → inline it (see `clients/tool-event.ts` for `isToolCallEventType`). It stays as an **optional peer + devDep** for types only.
- **`package-lock.json` IS committed and must stay in sync** with `package.json`. `npm run check:lockfile` (CI) fails on drift; after any dep change run `npm install` and commit the lock. CI/release use `npm install` (not `npm ci`) so a desync self-heals instead of wiping `node_modules`.
- The CI **install-test** (production tarball install + `tsx` load on 3 OSes) is the guard that catches misplaced runtime deps — keep it green.

## Build & packaging: precompiled dist + resource resolution (hard-won — #182)

pi-lens ships **precompiled JS**, not TypeScript source, so pi doesn't jiti-transpile ~200 files on every cold start (~3.5s → ~1.5s; the load cost is logged as `pi-lens loaded: <ms>ms … (from dist|source)` in `sessionstart.log` + `extension_loaded` in `latency.log`).

- `main` and `pi.extensions` → **`./dist/index.js`**. The published package ships `dist/` (compiled) + non-TS assets; it does **not** ship `.ts` source.
- **`dist/` is gitignored — never committed.** It exists only in the npm tarball, regenerated by `prepare` at install/pack time (and listed in `package.json` `files`). So `npm run build:dist` output never appears in `git status`, and you must never `git add` it. Run `build:dist` locally only to refresh what a warm MCP server / local pi loads — not to commit. (Reconciles "#182 precompiled dist" — shipped, not versioned.)
- **`prepare` (NOT `prepack`) builds `dist/`** via `build:dist` (`tsc -p tsconfig.dist.json --noCheck`). `prepare` runs on **every `npm install`, including `git:` installs (pi's install method)**, and before publish; `prepack` only fires on pack/publish, so a git install would get `main → ./dist/index.js` pointing at a file that was never built. `tsconfig.dist.json` overrides the inherited Node type library with `"types": []`, and `--noCheck` keeps the install-time build robust when dev-only `@types/node` is absent under `npm install --omit=dev`.
- **Two builds, don't confuse them:** `npm run build` (`tsconfig.build.json`) compiles **in place** next to the `.ts` — this is what the dev/test loop loads (vitest resolves `./x.js` to the in-place output, so stale in-place `.js` can shadow edits — rebuild). `build:dist` produces the shipped/loaded `dist/`.
- pi-lens's **own** assets are depth-robust: `rules/`, `config/`, grammars resolve via `getPackageRoot()` (`clients/package-root.ts`, walks up to `package.json`), so moving the entry into `dist/` doesn't break them.
- **GOTCHA — pi resolves each `pi.skills` entry relative to the extension entry's FILE PATH, not its directory and not the package root.** pi does `path.resolve(entryFile, skillEntry)` (verified in `@earendil-works/pi-coding-agent` `core/skills.js` + `package-manager.js`). With the entry at `./dist/index.js`, a leading `../` only cancels `index.js` and stays inside `dist/`, so `pi.skills` must climb **two** levels: **`["../../skills"]`** → `dist/index.js` → `../` (=`dist/`) → `../` (=root) → `skills/`. `"../skills"` resolves to `dist/skills` (missing) → skills silently don't load + `[Skill conflicts] skill path does not exist` (this regressed when the entry moved to `dist/` in #182 — the value was left at `../skills`, off by one; fixed in #199). `"./skills"` → `dist/index.js/skills` (missing); copying skills into `dist/skills` → same skill at root and dist → collision. Keep ONE skills dir (root `skills/`) and point `pi.skills` up two levels. **The tarball `skills/` ship-check does NOT validate this** — `tests/packaging.test.ts` now statically replicates `resolve(entryFile, skillEntry)` and asserts it lands on root `skills/`.
- Guarded by `tests/packaging.test.ts` + the CI install-test (tarball ships `dist/index.js` + root `skills/`, no `.ts`, compiled entry loads "from dist").

## Performance: the hot-path / event-loop discipline (hard-won — #188)

pi-lens's lifecycle hooks (`session_start`, `tool_call`, `tool_result`, `context`, `turn_end`, `agent_end`) run on the **same event loop as pi's TUI**. Any synchronous burst on a hook **blocks the user's keystrokes**. Slop accumulates because it's invisible on small repos and catastrophic on large (2k-file) ones. Invariants:

- **No hook's synchronous burst should block > ~50ms.** Heavy work is async + **chunked-yield** (`await new Promise(setImmediate)` every N items) or **deferred past the typing window** (a few-second `setTimeout`, not `setImmediate`).
- **Per-file / per-event work must be O(1) amortized** — memoize expensive derivations keyed by an invalidation signal (`.gitignore` mtime, `fileSeq`, content hash); never recompute-from-scratch on repeat (e.g. `ignoreMatcher.isIgnored` was recomputed per file per scan — now memoized).
- **Expensive scans run once, cache (process memo + disk), reuse across sessions/turns.** Cold start does the minimum (forced "quick" mode), then a deferred background warmup fills caches.
- **No `readdirSync`/`statSync`/`readFileSync` or regex-over-all-files on a hook path** unless bounded and yielding.
- **Measure, don't guess:** `~/.pi-lens/latency.log` logs per-phase/`tool_result` durations + `session_start total`; `npm run logs:smells`. PR #188 is the worked template.
- **Guard occupancy, not duration, at scale (#192):** use `tests/support/perf-harness.ts` — `measureMaxSyncBlockMs(work)` measures the longest synchronous stretch the work held the event loop (an independent loop-lag sampler, so it catches a *fully non-yielding* regression, which a duration timer or wrapping the code's own `setImmediate` would miss), and `generateSourceTree(dir, n)` builds a scaled fixture (the burst is O(files) and hides at pi-lens's ~300). New hot-path budget guards (see `tests/clients/source-walk-occupancy.test.ts`) assert `measureMaxSyncBlockMs(...) < ~300ms` on a ~1k+ fixture, with `{ retry: 2 }` to soak ambient parallel-suite load. Keep the fixture light enough not to starve the parallel suite.
- **Runtime occupancy monitor:** `clients/event-loop-monitor.ts` wraps Node's native `monitorEventLoopDelay` (enabled at extension load, zero per-event overhead). `getEventLoopStats()` (worst block / p99 / mean since session) is surfaced in `/lens-health`. Caveat: the native histogram's *capture* is unreliable inside vitest's worker, so test the wrapper contract (lifecycle/finite conversion), not block magnitude — block magnitude is what `measureMaxSyncBlockMs` (test-side, setImmediate sampler) is for.

## Internal edit substrate direction

Phase 6 in `implementation.md` is intentionally **not** a public `lens_edit` tool. It should be an internal mutation substrate to reduce failed edits in pi-lens-owned paths while preserving the native agent edit lifecycle:

```text
Native agent edit/write path:
read expansion → read guard → oldText autopatch → native edit → tool_result pipeline

pi-lens-owned mutation path:
seq/hash/range validation → atomic apply → read-guard stamp → seq/change-log → normal post-edit pipeline
```

Use it first for partial apply, then LSP workspace edits/actionable autofix. It must not bypass read guard for normal agent edits, replace oldText autopatch, guess stale ranges, or apply project-wide edits by default.

## SDK-reuse boundaries (deliberate — don't naively "simplify")
A 2026 audit against `@earendil-works/pi-coding-agent` confirmed a few places where pi-lens intentionally does *not* reuse an SDK facility:
- **Per-session diagnostic persistence** uses our own sidecar store (`clients/session-state-store.ts` → `getProjectDataDir/sessions/<id>.json`, atomic overwrite) rather than the SDK's `pi.appendEntry`/`getEntries`. `appendEntry` is append-only, so writing a fresh widget snapshot every `turn_end` would bloat the session JSONL with superseded copies; overwrite-in-place is the right fit. (The one genuine upside of `appendEntry` — fork/branch inheriting state for free — would let us drop the `session_before_fork` in-memory hand-off; revisit only if that hand-off becomes painful.)
- **Context injection** prepends a raw `{role:"user"}` message on the `context` hook **on purpose** (keeps the user's prompt as the trailing message). The documented `before_agent_start`/`appendCustomMessageEntry` paths can't satisfy the trailing-message constraint — don't migrate to them.
- **`safeSpawnAsync` over `pi.exec`** — see Runner process model (Windows UTF-8/tree-kill/`.cmd`/batch that `pi.exec` lacks).

## Open design TODOs

- **Project-diagnostics adapter backlog (#179)** — turn-end/project runners are normalized into `ProjectDiagnostic` records and surfaced via `lens_diagnostics` delta/full (#175). Only the Knip adapter (`clients/project-diagnostics/runner-adapters/knip.ts`) is done; test-runner, call-graph, Madge, jscpd, type-coverage, compiler checks (`/lens-booboo`), and production-readiness signals still emit advisory text only. Mirror the Knip adapter pattern + wire into `runtime-turn.ts` `projectDiagnosticsDelta`.

- **LSP server preference via project config** — `clients/lsp/config.ts` supports `.pi-lens/lsp.json` with `disabledServers` and custom server entries, but there is no way to express a *preference* between built-in candidates (e.g. prefer `basedpyright` over `pyright` when both are installed). `PythonServer.spawn()` currently uses first-found-wins ordering (`pyright-langserver` before `basedpyright-langserver`). A future `preferredServer` key in `LSPConfig` should let projects override this ordering; the server policy layer (`clients/lsp/server-policy.ts`) is the right place to apply the preference before candidate resolution.

## Async-spawn migration — DONE (#197, closed)
The sync→async spawn migration is complete; the patterns above (`safeSpawnAsync`, ambient abort signal, async-only `createAvailabilityChecker`, per-client `*Async` probes) are the steady state. What's intentionally left sync, by design — do **not** "fix" these without a real reason:
- `commands/booboo.ts` (~30 sync `safeSpawn`) — the user-invoked `/lens-booboo` full-codebase review; blocking is acceptable and converting would ripple through the command for no hot-path benefit.
- `TestRunnerClient.detectRunner`'s `which pytest` probe — cached per `(cwd, runner)`, fires once for a Python project with no config-file runner; converting it would ripple async through five methods (`findTestFile`/`getTestRunTarget`/`suggestTestFiles`/…) into the per-edit turn path for a one-time stutter.
- The deprecated `safeSpawn`/`isCommandAvailable`/`findCommand` exports in `clients/safe-spawn.ts` stay only for the two cases above.

For new runner tests, mock `safeSpawnAsync` (async); only mock the sync `safeSpawn` when testing one of the two legacy callers above.

## Actionable warnings routing

Every dispatch warning passes through one of two recorders in `clients/pipeline.ts`:

| Recorder | Required diagnostic fields | Destination |
|---|---|---|
| `recordFromDispatchDiagnostic` | `semantic === "warning"` AND `severity === "warning"` AND (`fixable` OR `fixSuggestion`) | `actionable-warnings.json` — surfaces an advisory and can drive autofix |
| `recordFromCodeQualityDiagnostic` | `semantic === "warning"` or `"none"` AND `severity !== "error"` AND (no fixable, no fixSuggestion, no autoFixAvailable) | `code-quality-warnings.json` — informational history only |

A runner that wraps a tool with an auto-fix capability **must** propagate `fixable: true` or `fixSuggestion: "<rule-specific guidance>"` per diagnostic — otherwise everything it produces silently goes to code-quality and never reaches the actionable advisory. Severity-`error` diagnostics route to blockers instead, regardless of fixability.

Patterns by tool capability:
- **Tool exposes per-diagnostic fix metadata** (biome, eslint, ruff, rubocop, shellcheck, oxlint via `--format json` + `help`, ast-grep, tree-sitter via `has_fix`): read it directly, set `fixable: !!fix` or `fixSuggestion: help`.
- **Tool has `--fix` but no per-warning fix flag** (stylelint, markdownlint): static allowlist of rule IDs documented as deterministically fixable. False positives are worse than false negatives — keep the list conservative.
- **Tool has no auto-fix** (cpp-check, phpstan, javac, pyright, mypy, go-vet, actionlint, yamllint, etc.): hard-code `fixable: false`. The diagnostic correctly lands in code-quality.

When changing a serialized cache that feeds this pipeline (e.g. `clients/cache/rule-cache.ts`), bump `CACHE_VERSION` so old entries invalidate. The tree-sitter rule cache previously stripped `has_fix` on roundtrip, silently demoting every tree-sitter rule with auto-fix to non-fixable on any cache hit (commit `24af518`).

## ast-grep rules

Rules live in `rules/ast-grep-rules/rules/*.yml` (plus the multi-rule `rules/ast-grep-rules/slop-patterns.yml`); disabled rules sit in `rules/ast-grep-rules/rules-disabled/` (sibling dir — not loaded). Run by `clients/dispatch/runners/ast-grep-napi.ts`.

- **Native napi engine (#206).** The runner matches every rule through napi's own engine — `root.findAll({rule, constraints})` — fed by a faithful `js-yaml` parse (`parseSimpleYaml` is a thin `js-yaml` wrapper). The old hand-rolled YAML parser + ~240-line interpreter and the `ast-grep-native-rules` flag are **gone**. The full grammar works: nested `any`/`all`/`has`, `inside`/`follows`/`precedes`, `field`, `nthChild`, and metavariable `constraints`. A rule napi rejects is skipped (never partially evaluated).
- **`has`/`inside` default to the immediate child/parent** (`stopBy: neighbor`). Add `stopBy: end` for a recursive descendant/ancestor search — required when the target isn't a direct child (e.g. `switch-without-default` needs it: `switch_default` lives under `switch_body`). Conversely, leave direct-child `has` at the default or it over-reports (`throw has string` + `end` flags `throw new Error("x")`).
- **Quote YAML-special scalars** — `js-yaml` throws on `message: !!x` or a bare `:` in a value and the rule is silently dropped.
- **Use tree-sitter-typescript kind names**, not TS-compiler/Roslyn: `subscript_expression` (not element_access_expression), `member_expression` (not property_access_expression), `statement_block` (not block), `for_in_statement` (covers for...of). A wrong kind → napi rejects the whole rule.
- One `language: TypeScript` rule runs on .ts/.tsx/.js/.jsx; don't ship a `-js` twin (it double-fires on the same node). Catalog: `rules/rule-catalog.json` (globally-unique `rule_id`s; `audit:rule-catalog` gate). Authoring guide: `skills/write-ast-grep-rule/SKILL.md`.

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
v3.8.52 is the package version. Recent shipped highlights: **read-guard path-key canonicalization** (#210 — all maps key through `normalizeFilePath`, fixes false `zero_read` blocks across mixed separators/casing); **#209 tool-coverage layers** — a deterministic per-PR registry-consistency guard (`tests/clients/installer/tool-registry-consistency.test.ts`, locks `installTool`'s contract + `GITHUB_TOOLS`↔registry sync) and an opt-in live tool-smoke harness driving the real dispatch path (`scripts/smoke-tools.mjs` + `dispatchLintDetailed`/`onRunnerResult` sink); read-guard autopatch (Tier C unicode-punctuation, trailing empty lines, `out_of_range` downgrade, repeat-failure escalation); runner `failureKind` classification + log-smell analyzer (#207); LSP content-hash diagnostic cache; precompiled-`dist` startup (#182). **Known finding (open):** `markdownlint` is registered but absent from the markdown write-dispatch group (`language-policy.ts` → `["spellcheck","vale"]`), so it never runs on markdown writes. CI runs `npm install` + tsc lint + vitest + a lockfile-sync guard (`npm run check:lockfile`). `package-lock.json` IS committed and must stay in sync with `package.json` — after any dependency change run `npm install` and commit the updated lock (the guard fails CI on drift). Runtime deps must live in `dependencies`, never `devDependencies`: pi installs extensions with `npm install --omit=dev`, so a runtime import of a dev-only package fails to load at user sites. The host SDK (`@earendil-works/pi-coding-agent`) must be imported type-only — it is not present under `--omit=dev`, and pulling it in drags a huge tree with Windows-illegal long paths that breaks `git clean` on update.

## Test requirements
Every commit that adds or changes logic **must** include relevant tests before pushing. No exceptions:
- New functions → unit tests covering the happy path, edge cases, and error paths.
- New tool parameters → tool-level routing tests verifying the parameter reaches the right handler.
- Bug fixes → a regression test that would have caught the bug.
- Run `npm test` (or `npm run build && npm test` if `.js` artifacts may be stale) and confirm all tests pass before committing.
- **Also run `npm run lint` before pushing — especially for test-file changes.** `npm run lint` (`tsc -p tsconfig.json`) is the strict CI gate and type-checks the `tests/` tree; `npm run build` (`tsconfig.build.json`) **excludes tests** and `build:dist` uses `--noCheck`, so a type error in a test compiles clean locally but fails CI lint. (This has bitten us — build passing ≠ lint passing.)

### Testing extension wiring (#171)
For anything that goes through the `index.ts` entry — flag/command/tool/hook registration, the `context` injection toggle, `tool_call`/`tool_result` read-guard wiring, `session_start` registrations — use the shared harness in `tests/support/pi-mock.ts` instead of hand-rolling an `ExtensionAPI`/ctx mock:
- `createPiMock(initialFlags?)` → records `flags`/`commands`/`tools`/`handlers`, backs `getFlag`, and exposes `getTool`/`getCommand`/`getHandlers`, `emit(event, payload, ctx)` to drive a hook, and `runCommand(name, args, ctx)`. Run the entry with `piLens(pi.asExtensionAPI())`.
- `makeCtx({ cwd })` → a minimal command/handler context that captures `ui.notify`/`setStatus`/`setWidget` into `ctx.notifications` / `ctx.statusCalls` / `ctx.widgetCalls`.
`tests/lens-toggle-command.test.ts` is the migration template; migrate other bespoke `createCtx`/`vi.mock` blocks to the harness opportunistically.

## Commit conventions
- Always include the GitHub issue number in the commit subject line: `(closes #NNN)` or `(refs #NNN)`.
- Use `closes` only when the commit fully resolves the entire issue; use `refs` for any partial work.
- GitHub auto-closes an issue on any commit containing `closes #NNN` regardless of trailing text — "closes #125 Phase 1" still closes #125.

## Issue triage & labels
Every issue should carry **one TYPE label + at least one `area:` label**.

- **TYPE (pick one):**
  - `bug` — something is broken / behaves wrong.
  - `feature` — a **net-new capability**: a command, agent tool, runner/formatter/LSP, integration, or config surface that **didn't exist**.
  - `enhancement` — **improve/harden/refactor/perf/test an existing** capability (no net-new surface).
  - `documentation` — docs only.
  - Litmus, feature vs enhancement: *does it add something a user/agent can invoke or configure that wasn't there before?* Yes → `feature`; "make the existing thing better/faster/cleaner" → `enhancement`. (GitHub's stock `enhancement` description conflates both — we deliberately split them; `feature` is green `#0e8a16`.)
- **AREA (one or more, color `#0052cc`):** `area:lsp`, `area:dispatch` (runners/linters/formatters), `area:installer` (tool auto-install / binary fetch), `area:diagnostics` (model/surfacing/suppression/project-diagnostics), `area:read-guard` (read-guard + edit substrate), `area:project-intelligence` (codebase model/scan/debt/ranking), `area:perf`, `area:observability` (telemetry/health/status), `area:session`, `area:config`, `area:security`, `area:tests`.
- Reuse GitHub defaults as needed (`good first issue`, `help wanted`, `question`, `duplicate`, `wontfix`).
- New issues (incl. agent-filed) get labelled at creation: `gh issue create … --label "feature,area:dispatch"`.

## Conventions
- TypeScript ESM throughout (`"type": "module"`)
- Edit the `.ts` sources only. Do **not** hand-edit sibling/generated `.js` files in this repo; pi loads TS via on-the-fly jiti transpilation and JS files are generated artifacts. If tests/runtime could see stale `.js`, run `npm run build` to regenerate from TS before testing.
- Tests use vitest; mocks via `vi.mock` / `vi.hoisted`
- Fire-and-forget background work uses `void expr` or `setImmediate`
- `logSessionStart()` is a no-op in test mode (`VITEST` env var)
- LSP tool: use `goToDefinition` / `findReferences` before grepping for symbols
- `clients/runtime-config.ts` is "pure constants" by intent. Resolutions that read disk or env (e.g. `getRunnerTimeoutFloorMs`) must be **lazy memoized getters** with a `_resetForTests` hook, not module-level reads, so importing the file has no I/O side effect and tests can override inputs deterministically.
- Numeric inputs from env vars or JSON config that flow into `Math.max` / `Math.min` must be coerced through a `Number.isFinite(n) && n > 0` guard. `Number(undefined) === NaN`, and a single NaN argument makes `Math.max` return NaN, which `setTimeout` silently treats as 0.
