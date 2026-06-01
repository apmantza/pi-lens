# codedb-inspired pi-lens implementation plan

## Goal

Adopt the useful parts of codedb's architecture that fit pi-lens: fast persistent project intelligence, consistent snapshot/version semantics, cheap reverse-dependency queries, and safer agent edits. Do **not** replace LSP or turn pi-lens into a separate required daemon.

## Principles

- Keep pi-lens hook-driven and lightweight.
- Preserve LSP as the source of truth for type-aware diagnostics.
- Prefer persisted project snapshots over repeated startup scans.
- Give reports a project/file sequence so agents can detect stale context.
- Make reverse dependencies and recently changed files cheap first-class queries.
- Keep expensive indexes lazy and opt-in.

## Phase 1 — Project intelligence snapshot

Status: **foundation implemented**. `clients/project-snapshot.ts` now saves/loads a versioned, seq-stamped project snapshot, hydrates cached exports and project rules at session start, and refreshes the snapshot when project rules, ast-grep exports, or project-index metadata are available.

Create a single persisted snapshot that consolidates the data pi-lens already computes in separate places.

### New file

`clients/project-snapshot.ts`

### Snapshot shape

```ts
export interface ProjectSnapshot {
  version: 1;
  projectRoot: string;
  generatedAt: string;
  seq: number;
  files: Record<string, ProjectSnapshotFile>;
  symbols: Record<string, ProjectSnapshotSymbol[]>;
  reverseDeps: Record<string, string[]>;
  ruleScan?: {
    hasCustomRules: boolean;
    rules: unknown[];
  };
}

export interface ProjectSnapshotFile {
  path: string;
  mtimeMs: number;
  size: number;
  hash?: string;
  language?: string;
  lineCount?: number;
  imports?: string[];
  symbolCount?: number;
  lastSeq: number;
}

export interface ProjectSnapshotSymbol {
  name: string;
  kind: string;
  filePath: string;
  startLine?: number;
  endLine?: number;
}
```

### Storage

- Latest snapshot:
  - `.pi-lens/cache/project-snapshot.json`
- Metadata:
  - `.pi-lens/cache/project-snapshot.meta.json`

Use `CacheManager.writeCache("project-snapshot", ...)`.

### Initial scope

Consolidate existing cached data:

- project file inventory
- cached exports / symbol index
- review graph dependency edges
- reverse dependency map
- project rule scan summary

Do not initially add full-text/trigram indexing.

### Acceptance criteria

- Session start can load snapshot if fresh and compatible.
- Snapshot invalidates on cache version mismatch.
- Snapshot skips ignored/generated/vendor files using existing project scan policy.
- Snapshot build is guarded by existing startup-scan in-flight protection.

## Phase 2 — Monotonic project/file sequence

Status: **foundation implemented**. `RuntimeCoordinator` now maintains project/file sequence counters, seeds them from the persisted change log at session start, and exposes `projectSeq`, `turnStartProjectSeq`, `bumpFileSeq()`, and `getFileSeq()`.

Add codedb-style sequence numbers to make reports and edits staleness-aware.

### Runtime state

Add to `RuntimeCoordinator`:

```ts
private _projectSeq = 0;
private _fileSeq = new Map<string, number>();

bumpFileSeq(filePath: string): number;
getFileSeq(filePath: string): number;
get projectSeq(): number;
```

### When to bump

Bump on every pi-observed disk mutation:

- successful write/edit tool result
- pi-lens immediate autofix
- pi-lens deferred format
- partial apply
- future project autofix
- applied LSP workspace edit

### Report integration

Add sequence metadata to:

- `actionable-warnings.json`
- `code-quality-warnings.json`
- `turn-end-findings-last.json`
- future project snapshot

Example:

```json
{
  "projectSeqStart": 120,
  "projectSeqEnd": 126,
  "files": [
    { "filePath": "src/a.ts", "fileSeq": 33 }
  ]
}
```

### Acceptance criteria

- Agent-facing reports can state whether they are latest-turn reports.
- Agent-end autofix can reject stale actionable-warning reports when project seq advanced unexpectedly.

## Phase 3 — Changes-since API/cache

Status: **foundation implemented**. `clients/project-changes.ts` now appends `<project-data-dir>/change-log.jsonl`, reads the latest project/file sequence state, and exposes `readChangesSince()`.

Create a cheap query equivalent to codedb `changesSince(seq)`.

### New runtime/cache data

Append-only project change log:

- `<project-data-dir>/change-log.jsonl`

Use the same project data directory convention as worklog/metrics history so sequence state survives sessions without coupling it to repository checkout files.

Entry:

```ts
interface ProjectChangeEntry {
  seq: number;
  timestamp: string;
  sessionId: string;
  turnIndex: number;
  source: "agent-write" | "agent-edit" | "format" | "autofix" | "partial-apply" | "lsp-edit" | "external";
  filePath: string;
  fileSeq: number;
  changedRange?: { start: number; end: number };
}
```

### API/helpers

`clients/project-changes.ts`

```ts
appendProjectChange(cwd, entry)
readChangesSince(cwd, seq, maxEntries?)
```

### Use cases

- Session-start guidance can say “last session modified these files.”
- Reports can link to exact changes since the agent's last read.
- Future tools can expose this as `lens_changes`.

## Phase 4 — First-class reverse dependency index

Status: **foundation implemented**. `clients/reverse-deps.ts` can build `file -> imports` and `file -> importedBy` indexes from the existing review graph, persist them into the project snapshot, reload fresh snapshot-backed indexes, and answer bounded reverse-dependency / affected-file queries. Cascade graph builds now opportunistically refresh the snapshot reverse-dependency section and merge fresh cached reverse-dependency neighbors into cascade neighbor selection.

Make reverse dependency lookup a cheap primitive instead of only a cascade byproduct.

### Build source

Use existing review graph builder/import extraction.

Persist:

- `file -> imports`
- `file -> importedBy`

inside `project-snapshot.json` or separate cache:

- `.pi-lens/cache/reverse-deps.json`

### API

`clients/reverse-deps.ts`

```ts
getReverseDeps(cwd, filePath): string[]
getAffectedFiles(cwd, filePath, depth = 1): string[]
```

### Integrations

- `computeCascadeForFile`
- turn-end test suggestions
- session-start guidance
- future code-quality report context

### Acceptance criteria

- Reverse deps query avoids rebuilding full graph on common path.
- Cache updates incrementally for edited files where possible.

## Phase 5 — Project friction / hot files summary

Status: **not implemented**. This phase should aggregate the telemetry pi-lens already collects into a small, agent-useful report instead of adding more raw logs.

### Goal

Create a bounded project-friction summary that consolidates recent changes, edit friction, diagnostics, complexity trends, latency, and reverse-dependency fanout. The purpose is to help agents notice risky or high-friction files without reading many separate logs.

Prefer a broader name than just "hot files":

- Latest cache: `.pi-lens/cache/project-friction.json`
- Optional compatibility/view: `.pi-lens/cache/hot-files.json`

### Existing signal inventory

Use existing sources first:

| Source | Path | Useful signals |
|---|---|---|
| Project changes | `<project-data-dir>/change-log.jsonl` | recently changed files, edit frequency, mutation source (`agent-edit`, `format`, `autofix`, `partial-apply`, etc.), latest project/file seq |
| Read guard | `~/.pi-lens/read-guard.log` | failed edit risk: `oldtext_duplicate`, `oldtext_not_found`, `edit_blocked`, `edit_warned`, `edit_partial_apply`, autopatch counts |
| Code-quality history | `<project-data-dir>/code-quality-warnings.jsonl` | recurring non-fixable code-quality warnings by file/rule/category |
| Actionable warnings | `.pi-lens/cache/actionable-warnings.json`, `~/.pi-lens/actionable-warnings.log` | current fixable warnings, LSP enrichment failures/skips, stale autofix skips |
| Diagnostic history | `~/.pi-lens/logs/YYYY-MM-DD.jsonl` | recurring diagnostics across sessions, noisy rules, unresolved patterns |
| Worklog | `<project-data-dir>/worklog.jsonl` | fixable/autofixed diagnostic history by file/rule |
| Latency | `~/.pi-lens/latency.log` | slow files/runners/phases, repeated expensive dispatches |
| Cascade | `~/.pi-lens/cascade.log` | cascade diagnostics, cold snapshot touches, reverse-deps cache refresh/load/merge, neighbor counts |
| Project snapshot | `.pi-lens/cache/project-snapshot.json` | reverse dependency fanout, cached project metadata |
| Metrics history | `<project-data-dir>/metrics-history.json` | maintainability/cognitive/nesting/max-cyclomatic/entropy trends and TDI |

### Metrics/complexity consolidation

The current metrics story is split and partly unused:

- `clients/complexity-client.ts` computes rich per-file code metrics: maintainability index, cognitive/cyclomatic complexity, nesting, function length, Halstead, entropy, and AI-slop indicators.
- `clients/metrics-history.ts` persists a subset of those metrics and computes trends / TDI.
- `clients/metrics-client.ts` tracks session entropy baselines but is barely used beyond construction/reset/pass-through.

Plan:

1. Treat `ComplexityClient` as the source of truth for code metrics.
2. Fold or deprecate `MetricsClient` session entropy tracking unless a real call path uses it. Entropy already exists in `FileComplexity` as `codeEntropy` and in metrics history snapshots.
3. Move toward a single `code-metrics` service/module that exposes:
   - `analyzeFile(filePath): FileComplexity | null`
   - `captureSnapshot(cwd, filePath, metrics)`
   - `loadHistory(cwd)` / `computeTrendSummary(cwd)` / `computeTDI(cwd)`
   - optional `compareToBaseline(filePath, previous, current)` for turn-end regressions
4. Preserve existing APIs during migration to avoid churn, but stop adding new uses of `MetricsClient` unless it is merged into the consolidated service.

### Proposed report shape

```ts
interface ProjectFrictionReport {
  generatedAt: string;
  projectSeq?: number;
  window: {
    sinceSeq?: number;
    maxAgeHours?: number;
    maxEntries: number;
  };
  summary: {
    files: number;
    changedFiles: number;
    readGuardEvents: number;
    codeQualityWarnings: number;
    slowDispatches: number;
    complexityRegressions: number;
  };
  files: Array<{
    filePath: string;
    displayPath: string;
    score: number;
    reasons: string[];
    lastChangedAt?: string;
    projectSeq?: number;
    fileSeq?: number;
    changeCount?: number;
    mutationSources?: Record<string, number>;
    readGuard?: {
      blocked?: number;
      warned?: number;
      oldTextNotFound?: number;
      oldTextDuplicate?: number;
      partialApply?: number;
      autopatched?: number;
    };
    diagnostics?: {
      recurring?: number;
      topRules?: Array<{ rule: string; count: number }>;
      codeQuality?: number;
      actionable?: number;
      autofixed?: number;
    };
    complexity?: {
      maintainabilityIndex?: number;
      cognitive?: number;
      maxCyclomatic?: number;
      entropy?: number;
      trend?: "improving" | "stable" | "regressing";
      miDelta?: number;
    };
    dependency?: {
      reverseDepFanout?: number;
      cascadeNeighborCount?: number;
      cascadeDiagnostics?: number;
    };
    latency?: {
      dispatchCount?: number;
      maxMs?: number;
      avgMs?: number;
      slowestRunner?: string;
    };
  }>;
}
```

### Scoring guidelines

Keep scoring simple and explainable. Each file accumulates points and `reasons`:

- +3 repeated `edit_blocked` / stale read-guard blocks
- +2 `oldtext_duplicate` / `oldtext_not_found`
- +2 recurring code-quality warning
- +2 maintainability trend regressing
- +1 format/autofix touched repeatedly
- +1 high reverse-dependency fanout
- +1 slow dispatch / runner hotspot
- cap or normalize to a 0–100 score

The report should always include the reason strings so agents do not need to trust a magic score.

### Agent-facing use

Session-start guidance can include only the top few items:

```text
Project friction summary:
  clients/read-guard-tool-lines.ts — repeated oldText failures, edited 4x, 2 quality warnings
  clients/runtime-session.ts — high fanout (12 dependents), slow cascade, format touched last session
  index.ts — maintainability trend regressing (MI -4.2)
```

Rules:

- Advisory only; never a blocker.
- Top 3–5 files max.
- Prefer concrete reason labels over raw metric dumps.
- Include path to full JSON report.
- Suppress if no meaningful signals.

### Implementation order

1. Add `clients/project-friction.ts` with pure aggregation helpers and tests using fixture logs/cache files.
2. Aggregate `change-log.jsonl`, `code-quality-warnings.jsonl`, and `metrics-history.json` first — these are project-scoped and stable.
3. Add parsers for bounded tails of global logs (`read-guard.log`, `latency.log`, `cascade.log`, daily diagnostic JSONL). Tail only recent N lines to avoid startup cost.
4. Add reverse-dep fanout from project snapshot.
5. Write `.pi-lens/cache/project-friction.json` at session start after snapshot load or as a deferred background task.
6. Surface a concise advisory in session-start guidance.
7. Later, use the report in turn-end context when the current turn touches a known hot/friction file.

### Acceptance criteria

- Aggregator reads existing logs/caches without adding expensive hook-path work.
- Report is bounded and deterministic in tests.
- Session-start only surfaces concise, actionable top findings.
- Metrics/complexity consolidation plan is followed: no new dependencies on the unused `MetricsClient` entropy baseline path.
- Existing manual commands like `/lens-health` and `/lens-tdi` can reuse the aggregation helpers over time.

## Phase 6 — Internal edit substrate to reduce failed edits

Status: **not implemented**. This phase should be an internal pi-lens mutation substrate, not a new exposed `lens_edit` tool.

### Goal

Reduce failed edits by giving pi-lens-owned mutations a range + sequence/hash validated write path that complements the existing native edit lifecycle:

```text
Native agent edit/write path:
read expansion → read guard → oldText autopatch → native edit → tool_result pipeline

pi-lens-owned mutation path:
seq/hash/range validation → atomic apply → read-guard stamp → seq/change-log → normal post-edit pipeline
```

Keep the native `edit` tool path intact. Read expansion, read-guard preflight, oldText autopatch, and exact-text matching remain the first line of defense for model-authored edits. The new helper should be used where pi-lens itself already mutates disk or could safely do so after read-guard has proven a subset of changes.

### Why this limits failed edits

Recent read-guard telemetry showed common failures:

- `oldtext_duplicate` — exact `oldText` appears at multiple locations. A range-backed internal edit can target the specific resolved line range instead of matching ambiguous text globally.
- `oldtext_not_found` — file drift or copied text mismatch. A seq/hash check can fail early with a clear stale-file reason and current seq/hash instead of retrying fragile text.
- `file_modified` / snapshot `mismatch` — file changed after read or partial apply. `expectedFileSeq`/`expectedHash` makes the rejection explicit and actionable: re-read before editing.
- `out_of_range` — line drift outside recorded read ranges. The helper can require explicit range coverage or consume ranges already proven safe by read-guard resolution.

### Internal API sketch

Use an internal helper, likely `clients/lens-edit.ts` or similar:

```ts
applyInternalEdit({
  cwd,
  runtime,
  cacheManager,
  filePath,
  source: "partial-apply" | "lsp-edit" | "autofix",
  expectedFileSeq?,
  expectedHash?,
  edits: [
    {
      startLine,
      endLine,
      newText,
      expectedText?, // optional extra guard for the exact span
    }
  ],
  runPostEditPipeline?,
})
```

Return structured results:

```ts
type ApplyInternalEditResult =
  | { ok: true; changed: boolean; projectSeq: number; fileSeq: number }
  | {
      ok: false;
      reason:
        | "stale_seq"
        | "hash_mismatch"
        | "overlap"
        | "expected_text_mismatch"
        | "out_of_read_range";
      currentFileSeq?: number;
      currentHash?: string;
      suggestedAction: "re-read";
    };
```

### Safety

- Reject stale `expectedFileSeq` when provided.
- Reject stale `expectedHash` when provided.
- Reject overlapping ranges.
- Optionally verify `expectedText` against the exact range being replaced.
- Apply edits bottom-up to avoid line drift.
- Prefer atomic write via temp file + rename where possible.
- Record project change with the correct source.
- Bump file/project seq exactly once per changed file.
- Record read-guard write stamp.
- Add modified ranges/import-change metadata to `CacheManager`.
- Route through `handleToolResult`/normal post-edit pipeline when requested.
- Never silently guess or widen stale ranges.

### Initial integration order

1. **Partial apply** — first target. Read-guard already resolves which exact oldText replacements are safe; use the helper to apply only those proven replacements with range/seq bookkeeping and normal post-edit routing.
2. **LSP workspace edits** — share the same bottom-up/atomic/range application core, then add seq/change-log/read-guard bookkeeping for applied workspace edits.
3. **Actionable autofix** — after stale report checks pass, apply selected LSP quickfix edits through the same internal substrate.
4. **Future project autofix/manual flows** — only opt-in, never default hook-path project-wide mutation.

### Non-goals

- Do not expose a public `lens_edit` tool initially.
- Do not bypass read guard for normal agent edits.
- Do not replace oldText autopatch.
- Do not silently apply broad/project-wide edits.
- Do not downgrade safety to make stale edits succeed.

### Acceptance criteria

- Partial apply uses this internal path for resolved replacements.
- Failed internal edits return stale seq/hash/range details and recommend re-read.
- LSP workspace edits can reuse the same atomic/range application core.
- Actionable autofix can reuse the same bookkeeping after report freshness validation.
- Normal native `edit` behavior, read expansion, read-guard checks, and oldText autopatches remain unchanged.

## Phase 7 — Lazy heavy indexes

Status: **partly implemented / needs policy cleanup**. pi-lens already defers many startup scans, but the boundaries between interactive-path work, queued background work, and command-only heavy work should be explicit.

### Goal

Do not eagerly build everything at session start. Keep the interactive path fast, hydrate fresh persisted intelligence when available, and only rebuild expensive indexes when a hook/command actually needs them.

### Scheduling policy

Classify each project intelligence task by cost and freshness need:

| Class | Examples | Startup behavior | Hook-path behavior |
|---|---|---|---|
| Eager cheap | project seq seed, snapshot probe, cache metadata, file-kind detection | allowed on interactive path if bounded | allowed |
| Deferred warm | LSP config walk, tool preinstall/probe-cache refresh, fresh reverse-dep cache merge | `setImmediate` fire-and-forget; logs queued vs run time | avoid unless already warm |
| Background heavy | knip, jscpd, full review graph, project index, ast-grep export scan | only after session_start returns, guarded by in-flight locks | never synchronous |
| Command-only / explicit | full project health, future search-index rebuild, full dependency audit | only via command or opt-in config | never automatic |

### Keep eager/lightweight

- Seed project/file sequence state from `<project-data-dir>/change-log.jsonl`.
- Probe `.pi-lens/cache/project-snapshot.json` and hydrate only if `snapshot.seq === runtime.projectSeq`.
- Load small cache metadata files and latest-turn reports.
- Detect the edited file's `FileKind` and project root for dispatch.
- Read fresh reverse-dependency data from snapshot if available; do not rebuild graph on the interactive path.

### Keep lazy/background

- jscpd startup scan.
- knip startup scan and delta analysis when a startup scan is still in flight.
- full review graph rebuild / dependency extraction.
- expensive structural similarity/project index.
- ast-grep export scan when no fresh snapshot exports exist.
- project-friction aggregation over global logs.
- future full-text/trigram index.

### Triggering rules

- **Session start:** may queue background tasks, but should not await expensive scans. Continue logging queued delay separately from run duration.
- **Tool result:** may use cached data and per-file cheap checks only. If a cache is stale, record a best-effort advisory and queue refresh rather than blocking the edit pipeline.
- **Turn end:** may refresh targeted/delta indexes for touched files, subject to in-flight guards and short timeouts.
- **Commands:** may force full rebuilds because users explicitly requested them.
- **Tests:** should be able to disable background scheduling or await a deterministic drain helper.

### In-flight/cache guard requirements

- Every heavy project-root task has a root-keyed in-flight guard.
- Cache writes include version + project seq/source metadata where applicable.
- Stale cache reads degrade to missing data rather than triggering synchronous rebuilds.
- Long-lived timers/processes are `.unref()`'d where safe.
- Expensive tool availability checks use the probe cache before spawning.

### Acceptance criteria

- Warm `session_start` stays near the current ~150ms target.
- No hook path calls `safeSpawn()` or performs full-project scans synchronously.
- If knip/jscpd/review-graph scans are already running, subsequent turns reuse/skip rather than duplicate them.
- Snapshot/reverse-dep/project-friction consumers tolerate stale or missing caches without user-visible crashes.

## Phase 8 — Optional search index experiment

Status: **optional / not implemented**. codedb's trigram/word index is impressive, but pi-lens already has ripgrep, ast-grep, LSP navigation, cached exports, and project snapshots. Treat this as an experiment only after Phases 5–7 are solid.

### Goal

Provide a tiny persisted lookup cache for agent guidance when it is faster or more contextual than spawning a search tool. The cache should answer "where is this identifier/symbol mentioned?" and "what files are likely related?" — not replace `rg`, AST search, or LSP.

### Candidate feature

A lightweight word/symbol lookup cache for agent guidance:

- exact identifier lookup (`RuntimeCoordinator.cachedExports` can seed symbol definitions)
- symbol name lookup with kind/file metadata
- import/export relationship hints from project snapshot + reverse deps
- small substring or normalized-token lookup for project-specific terms
- optional co-change/recency boost from `change-log.jsonl`

### Storage sketch

Prefer extending the project snapshot only after the model proves useful:

```ts
interface ProjectSearchIndex {
  version: 1;
  seq: number;
  generatedAt: string;
  tokens: Record<string, Array<{ filePath: string; count: number; lines?: number[] }>>;
  symbols: Record<string, Array<{ filePath: string; kind?: string; line?: number }>>;
  files: Record<string, { tokenCount: number; mtimeMs: number; size: number }>;
}
```

Possible cache path if kept separate:

- `.pi-lens/cache/project-search-index.json`

### Query API sketch

```ts
lookupProjectTerm(cwd, term, opts?: { maxFiles?: number; includeLines?: boolean }): ProjectTermHit[]
lookupSymbolLike(cwd, name, opts?: { maxFiles?: number }): ProjectSymbolHit[]
getRelatedFiles(cwd, filePath, opts?: { maxFiles?: number }): RelatedFileHit[]
```

Ranking can combine:

- exact symbol definition/export match
- same directory/package/module
- reverse-dependency adjacency
- recent co-change in `change-log.jsonl`
- token frequency with caps to avoid common-word dominance

### Build strategy

- Build lazily from cached file inventory and touched files first.
- Update incrementally on pi-observed writes when a fresh index exists.
- Rebuild fully only via command or background task with time/size caps.
- Skip ignored/generated/vendor files using the same project scan policy as snapshots.
- Store line numbers only for low-frequency tokens; high-frequency tokens keep file counts only.

### Avoid initially

- full custom trigram engine
- replacing ripgrep/ast-grep/LSP navigation
- parsing every language deeply
- querying from hook paths when the cache is missing/stale
- indexing large/binary/generated files

### Acceptance criteria for pursuing

- Demonstrates clear latency or context-quality benefit over `rg`/cached exports in this repo.
- Adds no measurable warm-start regression.
- Reuses snapshot/seq invalidation semantics.
- Has deterministic tests for tokenization, stale cache rejection, and ranking.

## Things not to copy directly

- Required HTTP daemon.
- Replacing LSP with custom parsers.
- Polling watcher as the main source of truth; pi hooks already provide write/edit lifecycle events.
- Cloud/remote repo queries unless explicitly requested later.

## Suggested implementation order

1. ~~Project/file sequence tracking.~~ Done.
2. ~~Append-only change log.~~ Done.
3. ~~Add seq metadata to actionable/code-quality reports.~~ Done.
4. ~~Project snapshot cache consolidating existing indexes.~~ Foundation done.
5. ~~Reverse dependency cache/query helper.~~ Foundation done.
6. Project friction / hot files report.
7. Internal versioned edit substrate.
8. Optional search index experiment.

## Tests

Add tests for:

- sequence bumps on write/edit/format/autofix/partial apply
- stale report detection by seq
- changesSince filtering and max cap
- snapshot load/save/version invalidation
- reverse dependency lookup from cached graph — foundation covered
- project friction / hot files aggregation
- internal edit stale-seq rejection
- internal edit post-pipeline routing

## Open questions / decisions

- **Decision:** project sequence is persisted per project via `<project-data-dir>/change-log.jsonl`; session start seeds runtime state from the latest entry.
- Should file hashes be cheap line hashes, full content hashes, or mtime+size initially? Prefer mtime+size initially, full hash only for touched files.
- Should a future `lens_changes` tool be exposed to agents, or only used internally for guidance?
- **Decision:** the versioned edit helper stays internal initially. It should complement read expansion/read-guard/autopatch by powering pi-lens-owned mutations, not replace the native agent `edit` path or be exposed as a model-facing tool.
