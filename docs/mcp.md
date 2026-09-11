# pi-lens as an MCP server — implementation plan

> Local working doc. Tracks the design + progress for exposing
> pi-lens to Claude (Claude Code) as an MCP server, built so a *real review loop*
> can be created (Claude commits → Claude measures the commit's actual impact,
> not inferred from logs the user pastes).

## Goals (from the user)

1. **Make pi-lens usable by Claude in Claude Code** — irrespective of the overlap
   with the LSP/tsc/pyright hooks already wired on this machine.
2. **Build it so a real review loop can be created** — Claude makes commits to
   pi-lens, then observes the *real* behavioral + perf impact of those commits
   through the MCP, first-hand, synchronously.

## What the codebase already gives us (the reuse surface)

The host coupling is **thin**. Everything under `clients/` operates on
`(filePath, content, cwd)` — the host SDK (`@earendil-works/pi-coding-agent`) is
imported **only** in `index.ts` (the pi adapter) and tests.

Confirmed reuse points:

- **`dispatchLintWithResult(filePath, cwd, pi, modifiedRanges?, logContext?)`**
  (`clients/dispatch/integration.ts`) — runs the full per-edit pipeline and
  returns `DispatchResult` (diagnostics, blockers, warnings, fixed, output…).
  Its only host dependency, `pi: PiAgentAPI`, is **a one-method interface**:

  ```ts
  // clients/dispatch/types.ts
  export interface PiAgentAPI { getFlag(flag: string): string | boolean | undefined; }
  ```

  → trivially stubbable. This is the whole ballgame.
- **`getLatencyReports()`** (`dispatch/integration.ts`) — structured latency
  reports per dispatch (`filePath`, `totalDurationMs`, `runners[]`,
  `totalDiagnostics`). Same data `/lens-health` shows. **This is the review-loop
  measurement surface** — identical schema to what real pi runs emit.
- **`scanProjectDiagnostics({cwd, tier, maxFiles})`**
  (`clients/project-diagnostics/scanner.ts`) — project-wide cheap scan.
- **`getLSPService()`** (`clients/lsp/index.ts`) — `touchFile`,
  `runWorkspaceDiagnostics`, `getStatus`, `getAliveClientCount`. Holds warm LSP
  state across calls (a long-lived MCP process keeps servers hot).
- **lens-diagnostics formatters** (`tools/lens-diagnostics.ts`) —
  delta/all/full project diagnostic state, already a thin wrapper over caches +
  widget state.
- **`loadBootstrapClients()`** (`clients/bootstrap.ts`) — lazy client bundle.
- **`initLSPConfig(cwd)`** / **`loadPiLensGlobalConfig()` +
  `resolvePiLensFlag()`** (`clients/lens-config.ts`) — config + flag resolution
  for the `getFlag` shim.

## The two design tensions, resolved

### Push vs pull

pi-lens's value in pi is *push* (auto-injected on edit). MCP is *pull* (Claude
calls a tool). MCP alone gives a **queryable** pi-lens, not an auto-debugging
one. That's fine for **goal 1** (Claude explicitly asking "analyze this") and for
**goal 2** (the review loop is *inherently* a deliberate "measure now" action, so
pull is the natural shape). Auto-injection in Claude Code would be a *separate*
PostToolUse hook (out of scope here; noted as a future slice).

### Stale-process trap (the make-or-break for the review loop)

A Claude Code MCP server is a **long-lived stdio process**; it does **not**
hot-reload on source edits. If Claude commits and then calls the warm in-process
server, it reviews the **old** code while believing it's new — a convincing false
loop. Two analysis modes resolve this:

- **`warm` (in-process)** — fast, warm LSP, good for "use pi-lens while I code"
  (goal 1). Reviews whatever code the server was started with.
- **`fresh` (forked worker)** — each analysis forks a short-lived `node` worker
  that imports the **freshly-built `dist/`** and runs the analysis, returning
  JSON. dist is rebuilt on disk → the next `fresh` call automatically reflects
  the latest commit. Slower (spawn + cold), but **honest** — this is the review
  loop. Pair with `pilens_rebuild` so the loop is self-contained:
  commit → `pilens_rebuild` → `pilens_analyze mode=fresh` → `pilens_latency`.

`pilens_latency` returns the same schema as production `latency.log`, so a
Claude-driven `fresh` bench and the user's organic pi runs speak the same metric
language (mechanism + directional perf are certified by the loop; the organic
production *distribution* still belongs to real pi usage — documented limit).

## Architecture

```
Claude Code ──stdio/MCP──> pi-lens-mcp (dist/mcp/server.js)
                              │  thin transport + tool router (@modelcontextprotocol/sdk)
                              ▼
                           clients/mcp/analyze.ts   ← host-neutral facade
                              │  stubs PiAgentAPI via host-shim.getFlag
                              ▼
                           dispatchLintWithResult / scanProjectDiagnostics /
                           getLatencyReports / getLSPService / lens-diagnostics
                              ▲
                  fresh mode │ forks: node dist/mcp/worker.js --file … (imports current dist)
```

New files:

- `clients/mcp/host-shim.ts` — `createMcpHost()` → `{ getFlag }` backed by
  `loadPiLensGlobalConfig()` + `resolvePiLensFlag()` + env. No pi dependency.
- `clients/mcp/analyze.ts` — `analyzeFile(filePath, cwd, opts)` facade →
  `McpAnalyzeResult { diagnostics[], blockers, warnings, fixed, durationMs,
  latency }`. Pure/testable; the heart of the loop.
- `mcp/server.ts` — stdio MCP server; registers tools; routes to the facade /
  `fresh` worker. New entry point (sibling of `index.ts`).
- `mcp/worker.ts` — `fresh` mode child: imports current dist, runs `analyzeFile`,
  prints JSON, exits.

## MCP tool surface

| tool | maps to | purpose |
|------|---------|---------|
| `pilens_analyze` | `analyzeFile` (warm) / worker (fresh) | run the per-edit pipeline on a file; returns diagnostics + timing. `mode: warm\|fresh`. **Correctness + mechanism probe.** |
| `pilens_ast_grep_search` | `ast_grep_search` | AST-aware structural search. |
| `pilens_ast_grep_replace` | `ast_grep_replace` | AST-aware structural replace. |
| `pilens_diagnostics` | `lens_diagnostics` | session or LSP diagnostics, selected by `source`, `scope`, and `severity`. |
| `pilens_effective_config` | `effective_config` | resolved configuration and provenance. |
| `pilens_project_scan` | `scanProjectDiagnostics` | project-wide cheap scan. |
| `pilens_latency` | `getLatencyReports` | latency records (latency.log schema). **Review-loop measurement.** |
| `pilens_health` | `/lens-health` internals | runtime health snapshot. |
| `pilens_lsp_navigation` | `lsp_navigation` | IDE-style LSP navigation. |
| `pilens_module_report` | `module_report` | navigable module outline and dependents. |
| `pilens_project_report` | `project_report` | project-level structure and diagnostics report. |
| `pilens_read_enclosing` | `read_enclosing` | read the smallest enclosing symbol or callback. |
| `pilens_read_symbol` | `read_symbol` | read one symbol body. |
| `pilens_rebuild` | `npm run build:dist` | rebuild dist so `fresh` reflects the latest commit. Makes the loop self-contained. |
| `pilens_session_end` | session lifecycle | close the MCP session and flush lifecycle state. |
| `pilens_session_start` | session lifecycle | initialize session state and caches. |
| `pilens_symbol_search` | `symbol_search` | search the persisted symbol index. |
| `pilens_turn_end` | turn lifecycle | settle turn-end work and return findings. |

## Packaging / wiring

- `package.json`: add `"bin": { "pi-lens-mcp": "./dist/mcp/server.js" }`; add
  `@modelcontextprotocol/sdk` to `dependencies` (lockfile in sync — install
  constraint); `build:dist` already compiles all `.ts` → `dist/mcp/*.js` falls
  out for free.
- Claude Code registration (documented, user runs it):
  `claude mcp add pi-lens -- node <repo>/dist/mcp/server.js` (or `.mcp.json`).
- The server takes the workspace cwd from the MCP client / `--cwd`.

## Phasing

- **Phase 1 (this slice — verifiable now, no half-wired transport):**
  `host-shim.ts` + `analyze.ts` facade + unit tests (temp file with a known
  issue → assert diagnostics + a latency record came back). Establishes the
  host-neutral foundation both goals stand on.
- **Phase 2:** `mcp/server.ts` (stdio, SDK) with `pilens_analyze` (warm),
  `pilens_diagnostics`, `pilens_latency`; bin + package wiring; stdio smoke test
  (list-tools + one analyze) without needing Claude Code.
- **Phase 3:** `fresh` worker + `pilens_rebuild` → the honest review loop;
  `pilens_project_scan`, `pilens_health`.
- **Phase 4 (future, separate):** Claude Code PostToolUse hook for auto-injection
  (the *push* half) — out of scope for this doc.

## Constraints to honor (project standing rules)

- Host SDK type-only; MCP path must not import it at runtime (it doesn't —
  facade only touches `clients/`).
- Runtime deps in `dependencies`; lockfile committed + in sync (`check:lockfile`).
- Tests ship **with** the implementation, not after.
- `npm run build` before vitest (stale `.js` shadows edits); `npm run lint`
  before any push (CI gate).
- Nothing committed/pushed without explicit user instruction. `mcp.md` never
  committed.

## Progress log

- [x] Plan written (`mcp.md`).
- [x] Phase 1: `host-shim.ts` (`createMcpHost` → `{ getFlag }`)
- [x] Phase 1: `analyze.ts` facade (`analyzeFile` → `McpAnalyzeResult` incl. latency)
- [x] Phase 1: tests — `tests/clients/mcp/{host-shim,analyze}.test.ts` (9/9 green, build clean)
- [x] Phase 2: stdio server (`mcp/server.ts`) + tools + bin/package wiring + smoke test
      ↳ DECIDED: hand-rolled newline-delimited JSON-RPC, **zero new deps**
      ↳ `pilens_analyze`, `pilens_diagnostics`, `pilens_latency`
      ↳ 13/13 MCP tests green; lint clean; real end-to-end analyze confirmed
        (ran the live pipeline on a repo file, returned per-runner latency in
        latency.log schema — lsp cold-spawn 5.5s visible, exactly the #203 cost)
- [x] Phase 3: fresh worker + `pilens_rebuild` (honest review loop) + project_scan/health
      ↳ `mcp/worker.ts` (forked child loads freshly-built code from disk)
      ↳ `clients/mcp/review.ts` — `analyzeFileFresh` (direct node fork, space-safe
        on Windows), `runRebuild` (safeSpawnAsync npm), `resolveRebuildScript`
        (dist→build:dist, in-place→build, matched to the server's own layout)
      ↳ tools added: `pilens_analyze mode=warm|fresh`, `pilens_rebuild`,
        `pilens_project_scan`, `pilens_health`
      ↳ 20/20 MCP tests green; lint clean; real `mode=fresh` probe confirmed —
        forked worker ran the live pipeline, returned `[fresh]` + per-runner
        latency (lsp cold-spawn ~6s) loaded from disk, not the server's image

## Status: initial 3 phases shipped & committed; dogfooding opened Tier 1/2

Commit `73dd400` on `master` shipped the transport + the 6 tools; usable in
Claude Code today (goal 1) and the honest review loop is wired (goal 2): commit →
`pilens_rebuild` → `pilens_analyze mode=fresh` → `pilens_latency`, all in the
latency.log schema. **But live testing (see "Post-ship dogfooding" below) showed
the exposed surface is a narrow per-edit slice with real gaps (Findings A–F) —
next work is Tier 1 + Tier 2 there.**

Not yet done (deliberately, pending user go-ahead): full-suite regression run +
commit (standing rule: nothing committed without explicit instruction). Only
new files were added plus a one-line `tsconfig.dist` include and a `bin` entry —
no existing source was edited, so existing-test risk is minimal.

### Honest limits (unchanged from the design)

- `warm` mode reviews the server's started-with image; use `fresh` after a commit.
- A single `fresh` run is a controlled bench, not the organic production p50 —
  the user's real pi `latency.log` remains the final word on the live distribution.
- `fresh` pays a cold start each call (new process, cold LSP); `warm` is for speed.

### Future (separate slice, out of scope here)

- Claude Code PostToolUse hook for *auto-injection* (the push half) — MCP is pull.
- Warm-mode LSP reuse already happens (long-lived server); could expose an
  explicit warm-up tool to pre-pay the cold spawn.

## Post-ship dogfooding (2026-06-12) — what live testing revealed

Registered the server user-scope in Claude Code and exercised all 6 tools on a
real file with seeded problems. Everything *ran*, but using it surfaced that the
MCP exposes a **narrow slice**, plus concrete bugs. Findings:

- **A — `pilens_analyze` is blocking-only.** `dispatchLintWithResult` is called
  with `blockingOnly=true` (the per-edit fast path), so only *errors* surface —
  warnings/structural smells (`any`, deep nesting, async-noise) don't. Confirmed:
  a file with obvious smells returned 0 until a real type error was added → 2
  blockers.
- **B — wrong `fixSuggestion` (bug).** A TS2322 type-error diagnostic carried the
  *unused-var's* "Remove unused declaration" suggestion. Source is the dispatch
  lsp runner's code-action enrichment (`runners/lsp.ts`, `fixSuggestionByIndex`),
  NOT the MCP facade (which passes `fixSuggestion` straight through). Pre-existing.
- **C — `analyze` results invisible to `diagnostics`/`health`.** `analyzeFile`
  never records into widget-state/caches the way `pipeline.ts:978+` does
  (`recordDiagnostics` + `recordFrom{Dispatch,CodeQuality}Diagnostic` +
  `tracker.trackShown`). So `pilens_diagnostics`/`pilens_health` stay blind.
- **D — `fresh` mode systematically under-reports LSP diagnostics (the big one).**
  Same file: `warm` (warm LSP, 1209ms) → 2 blockers; `fresh` (cold LSP, 4639ms,
  new process) → 0. Cold LSP hasn't published diagnostics when the dispatch wait
  (`runners/lsp.ts`: `maxClientWaitMs=LSP_SPAWN_BUDGET_MS`, `maxDiagnosticsWaitMs=
  2500`) expires. `fresh` always cold-spawns → always under-reports LSP. The
  "honest-code" mode is **diagnostically incomplete** — the core review-loop flaw.
- **E/F — `project_scan` noisy + verbose.** Many `ts-path-traversal` "blocking"
  false-positives on pi-lens's own internal fs I/O, **duplicate** diagnostics
  (same line twice), and the payload dumps ~100 full objects (heavy for an MCP
  context). Needs dedupe + aggregation.
- **Bonus:** `project_scan` flagged real smells in pi-lens's own `index.ts`
  (cyclomatic complexity **266** and **145**, fan-out 176) — genuine refactor targets.

### Scope correction — pi-lens has THREE lifecycle layers; MCP runs only one

Initial assumption ("knip/jscpd are booboo-only") was **wrong**. Verified:

| layer | handler | runs |
|-------|---------|------|
| per-edit | `dispatchLintWithResult` | LSP, tree-sitter, ast-grep, fact-rules, biome/ruff/eslint/oxlint |
| per-turn | `handleTurnEnd` (`runtime-turn.ts`) | **knip**, **jscpd** (incremental, `getFilesForJscpd`), **madge/dep circular** (opt-in via `--lens-turn-end-madge`), **cascade merge**, **tests**, actionable/code-quality warnings aggregation, project-diagnostics delta |
| per-session | `handleSessionStart` (`runtime-session.ts`) | **jscpd full scan**, knip, type-coverage, dep, govulncheck, gitleaks, todo, complexity baselines, dominant-language **LSP warm** (#203). The production path does not currently populate the error-debt baseline. |

The initial MCP implementation invoked **none** of the lifecycle handlers —
only the per-edit layer. The shipped server now exposes `pilens_session_start`
and `pilens_turn_end`, which drive the real handlers; `fresh` analysis still
pays a cold LSP because it starts a new worker without session-start warming.

## Revised recommendation — drive the real lifecycle, don't re-plumb

### Tier 1 — make the per-edit slice honest & composable (small)

- **D:** warm the LSP before the measured dispatch (a generous-budget `touchFile`
  with `collectDiagnostics` so the server spawns + publishes, then dispatch reads
  the warm cache). Makes `fresh` complete; `warm` first-call too. Latency then
  reflects warm (steady-state) timing, which is the representative number anyway.
- **C:** in `analyzeFile`, replicate `pipeline.ts`'s recording —
  `recordDiagnostics` (widget→`mode=all`) + `tracker.trackShown` (→`health`) +
  `recordFrom{Dispatch,CodeQuality}Diagnostic` (→`mode=delta`).
- **A:** add a `warnings: true` option so analyze can surface the warning layer,
  not just blockers (feeds C's warning caches).
- Plus: dedupe/aggregate `project_scan` output (E/F).

### Tier 2 — expose the actual lifecycle handlers (the real answer)

Rather than re-implementing knip/jscpd/cascade/warnings as bespoke MCP tools,
**run pi's own handlers**:

- `pilens_session_start` (or auto-init on first call) → `handleSessionStart` →
  jscpd/knip/type-cov/dep full scan + LSP warm (the error-debt baseline is not
  currently populated by the production session-start path; this also
  fixes D at the source).
- `pilens_turn_end` → `handleTurnEnd` → knip/jscpd incremental + cascade + dep +
  tests + the actionable/code-quality aggregation.
- keep `pilens_analyze` for the per-edit layer.

This reconstructs the genuine **edit → turn → session** loop and answers the
knip/jscpd/cascade/warnings questions "for free" (same code pi runs). Cost: wire
the `deps` bundle the handlers need — `loadBootstrapClients()` (host-neutral) +
`getFlag`/`notify` stubs + a `RuntimeCoordinator`. This was the original wiring
cost; `index.ts`'s `session_start`/`turn_end` wiring remains the exact template
and the shipped `clients/mcp/session.ts` keeps the coupling thin.

An error-debt baseline would allow the MCP to report whether a change flipped
tests/build from green to red, but the production session-start path does not
currently populate that baseline, so this regression delta is not available.

### Plan: Tier 1 then Tier 2

Land Tier 1 first (makes the foundation honest; the un-warmed, un-baselined base
shouldn't carry more surface). Then Tier 2 on top. Tier 1's warm-LSP work is
partially subsumed by Tier 2's session-start warm, but per-analyze warm is still
needed for `fresh` (new process) and for files outside the warmed dominant language.

### Tier 1 — implementation notes (investigated, ready)

- D warm-up: `getLSPService().touchFile(abs, content, { diagnostics: "document",
  collectDiagnostics: true, clientScope: "primary", maxClientWaitMs: ~15000,
  maxDiagnosticsWaitMs: ~8000, source: "mcp-warmup" })` before dispatch; guard on
  `!getFlag("no-lsp") && supportsLSP`. Touch-debounce (#203) means the subsequent
  dispatch touch dedups the push and reads the warm cache.
- C recording imports: `recordDiagnostics` (`clients/widget-state.ts`),
  `recordFromDispatchDiagnostic` (`clients/actionable-warnings.ts`),
  `recordFromCodeQualityDiagnostic` (`clients/code-quality-warnings.ts`),
  `getDiagnosticTracker` (`clients/diagnostic-tracker.ts`). In `fresh` (worker
  process) these are harmless no-ops (process exits); they compose in `warm`.

### Progress (post-ship)

- [x] Tier 1 implemented (42 MCP/dispatch tests green, build + lint clean):
  - **A** — `analyzeFile` runs full (`blockingOnly=false`) by default + no-delta
    (consistent full snapshot); added `blockingOnly?` to `dispatchLintWithResult`
    (additive, default true preserves the per-edit path). Confirmed live: `fresh`
    now surfaces warnings (deep-nesting) where it previously showed 0.
  - **C** — `analyzeFile` records into widget-state (`recordDiagnostics`) +
    `getDiagnosticTracker().trackShown`, so `pilens_diagnostics mode=all` /
    `pilens_health` compose with `analyze` (in `warm`/in-process; no-op in `fresh`).
  - **D** — per-call LSP warm-up (`touchFile` collectDiagnostics, bounded
    10s/6s) before the measured dispatch + an explicit **`lsp` honesty signal**
    (`ran`/`status`/`diagnosticCount`/`durationMs`) on the result and in the
    summary line.
  - **E/F** — `summarizeScan` (in `review.ts`) dedupes by file:line:col:rule and
    aggregates by rule/file; `pilens_project_scan` now returns counts + a bounded
    40-item sample instead of ~100 raw objects.
- [x] Tier 2 (first slice): `pilens_session_start` + `pilens_turn_end` driving the
      REAL handlers via `clients/mcp/session.ts` (persistent RuntimeCoordinator +
      CacheManager + bootstrap bundle; thin getFlag/no-op stubs). Handlers emit
      through the cache/context bridge → we `consume*` it and return the text.
      `turn_end` registers caller-supplied edited files via `addModifiedRange` so
      the turn runners (knip/jscpd incremental, dep, tests, cascade) have a
      worklist. TypeScript verified both deps interfaces are fully satisfied; 4
      session unit tests; live `pilens_session_start` smoke confirmed end-to-end.
  - This exposes the previously-absent layers: knip dead-code, jscpd duplication,
    dep-circular, tests, cascade, actionable/code-quality aggregation (turn_end);
    LSP warm + complexity baselines + project scans (session_start). The
    error-debt baseline remains unpopulated by the production session-start path.
- [ ] Tier 2 follow-ups: have warm `pilens_analyze` auto-register edited files into
      turn-state (so `turn_end` needs no explicit file list); surface the error-debt
      green→red delta directly in the turn_end result; let session_start optionally
      block until the LSP has indexed (so warm analyze is immediately LSP-complete).

### D — honest limit found in live testing (matters for Tier 2)

The per-call warm-up helps fast servers (pyright/rust-analyzer/gopls) and a warm
typescript-language-server, but **cannot fully fix cold-LSP on a large TS
project**: cold `typescript-language-server` must load the whole project before
emitting diagnostics, which took ~30s in the warm session — longer than any
sane per-call budget. So `fresh` (always a cold process) still under-reports LSP
on big projects; `mode=fresh` confirmed `lsp diagnosticCount 0` on a file with a
real type error while all non-LSP runners (tree-sitter/ast-grep/fact-rules/oxlint)
returned complete results. The fix is **not** a bigger budget (that punishes every
call) — it's: (1) the `lsp` signal so a cold `0` is never read as "clean", and
(2) Tier 2's persistent session-start warm + giving the long-lived server time to
index → use **warm mode** for LSP-complete reviews. `fresh` = code-fresh + all
non-LSP runners complete, LSP best-effort.

## Tier 3 — full capability mirror (testable/debuggable directly)

Goal: mirror the *whole* pi-lens, including the push/inline half, so pi-lens can
be exercised + debugged directly through Claude Code without running pi.

### Progress

- [x] **Push/inline keystone** — `mcp/analyze-cli.ts` → bin `pi-lens-analyze`.
  Reuses the Tier 1 `analyzeFile` facade. Works as a Claude Code PostToolUse
  hook (reads the tool payload from stdin → `tool_input.path`/`file_path` + cwd)
  AND as a plain CLI (`--file=`). Defaults to `no-lsp` (FAST: ~1-2s, the cold
  LSP would cost ~5s/edit and under-report anyway — pull `pilens_analyze` on the
  warm server for type errors). Silent on clean files; advisory (always exit 0).
  `--hook` emits a PostToolUse `additionalContext` envelope; plain mode prints a
  report. 4 bin tests (CLI, --hook envelope, clean-file silence, stdin payload).

  Wire it in Claude Code `settings.json`:

  ```json
  { "hooks": {
    "PostToolUse": [
      { "matcher": "Edit|Write",
        "hooks": [ { "type": "command", "command": "pi-lens-analyze --hook" } ] } ],
    "Stop": [
      { "hooks": [ { "type": "command", "command": "pi-lens-analyze --turn-end", "timeout": 60 } ] } ]
  } }
  ```

  (the cold-LSP fix means the type-check is honestly reported as skipped, not a
  false clean; the agent pulls `pilens_analyze` warm when it wants types. The
  `Stop` half is the per-turn pass — see the bullet below.)

- [ ] **booboo** full-codebase review tool (`/lens-booboo` → handleBooboo:
  complexity, AI-slop, TODOs, dead-code, dupes, type-coverage).
- [ ] **command-equivalents**: TDI (technical-debt index), tool-status, git-guard.
- [x] **auto turn-state from analyze** — `analyzeFile` gains opt-in
  `registerTurnState` (default off so `fresh` benchmarking stays pure); the
  edit-detection paths (warm `pilens_analyze` + the `pi-lens-analyze` hook bin)
  enable it → write the file to on-disk turn-state via `addModifiedRange`.
  `pilens_turn_end` `files` is now OPTIONAL — call it with no args after edits and
  it picks up the auto-registered worklist. 2 unit tests + live-confirmed
  (bin → readTurnState shows the file). The edit→turn loop composes natively.
- [ ] **green→red #2** (build/typecheck delta — pending scope confirm; baseline is
  dormant in pi so the MCP must establish it).
- [x] **warm side-channel** — the PostToolUse hook reuses the server's warm LSP.
  The MCP server opens a second IPC endpoint (`clients/mcp/ipc.ts`:
  `ipcPathForCwd` → Unix socket / Windows named pipe, hashed per workspace)
  alongside its stdio transport; responses go over the socket so the MCP stream
  is untouched. The `pi-lens-analyze` bin tries the warm channel FIRST
  (`requestWarmAnalyze`) — when a server is up for the workspace it analyzes in
  the warm process (LSP-COMPLETE) and the bin never loads the dispatch graph;
  otherwise it falls back to cold no-LSP local analysis. Both server + hook
  derive the same endpoint from the resolved cwd hash, so they meet for the same
  project. 5 IPC unit tests (path stability, named-pipe round-trip, no-server +
  error → undefined fallback); live-proven (server "warm analyze" log fired,
  bin returned the diagnostic). Removes the one real weakness of the push half.
- [x] **Stop hook → per-turn pass** (#538) — the `pi-lens-analyze` bin gains a
  turn-end mode (`--turn-end`, or a Claude Code `Stop` payload on stdin), the
  analogue of pi's `agent_end`: incremental knip/madge, dep-circular,
  cascade-to-dependents, tests, actionable-warnings aggregation. PostToolUse has
  already accumulated the edited files into turn-state by the time `Stop` fires,
  so the hook passes no files and clears any inherited pi `sessionId` — turn-
  end's stale-session eviction leaves the registered worklist alone. The request is a
  tagged route (`{route:"turn-end"}`, own schema version) on the **workspace**
  socket, not the PID-scoped one: a Stop hook knows its cwd, never the server's
  pid. It rides in ahead of the parse, so it inherits the #535 build-staleness
  gate for free, and an untagged analyze request on the same socket is byte-for-
  byte unchanged. All workspace IPC requests share one server-side queue, so a
  timed-out PostToolUse client cannot let `Stop` overtake analysis still running
  in the server, and concurrent turn-ends cannot race the turn-state clear.
  **Warm-only, no cold fallback**: only the server process owns the session state
  and pending turn work, so a local pass would report a false clean — no warm
  server means one stderr line, silent stdout, exit 0.
  The client waits 55s so it gives up inside Claude Code's 60s hook timeout.
  `SubagentStop` is deliberately NOT registered: subagent edits already fire
  PostToolUse into the shared turn-state, the consume bridges are one-shot (a
  subagent pass would eat the main agent's findings into a transcript nobody
  reads), and the fan-out would multiply the heavy pass. Visibility, honestly:
  Stop-hook stdout is user-visible in transcript mode (Ctrl-R), NOT model
  context — blockers still gate commits through the retained lens-guard record,
  and a `decision:"block"` render is a follow-up. Tests run fire-and-forget
  inside turn-end, so the `Tests:` section you see is the *previous* turn's
  failures. Unit, bin, and live-route smoke tests cover transport, ordering,
  rendering, and spawned-server behavior.

## Transport decision — RESOLVED: hand-roll (zero new deps)

Rejected the SDK: `npm install --omit=dev` does **not** omit `optionalDependencies`
(only `--omit=optional` does, which pi doesn't pass), so "SDK as optional" would
still weigh down every pi-lens install. The tools-only MCP surface we need —
`initialize` / `tools/list` / `tools/call` (+ `ping`) over newline-delimited JSON
— is small and stable; a server only answers inbound requests by id. ~200 LOC in
`mcp/server.ts`, no SDK, pi's install byte-for-byte unchanged. Revisit the SDK
only if pi-lens ever becomes a *rich* MCP server (resources/prompts/sampling).

Robustness choices: server **mirrors the client's requested `protocolVersion`**
(sidesteps version drift); reroutes `console.log → stderr` so no transitively
loaded module can corrupt the stdout JSON stream; exits on stdin EOF (MCP
shutdown signal).

## How to use it in Claude Code (Phase 2 surface)

Build the dist (or use the in-place `npm run build` output), then register:

```
claude mcp add pi-lens -- node <repo>/dist/mcp/server.js --cwd=<workspace>
```

Then the tools `pilens_analyze`, `pilens_diagnostics`, `pilens_latency` are
callable from Claude Code. `pilens_analyze` runs the live pipeline; the long-lived
server keeps LSP servers warm across calls (first call pays the cold-spawn).
