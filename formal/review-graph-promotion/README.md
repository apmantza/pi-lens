# Review-graph promotion model

A TLA+ model of the worker-thread persist of the review-graph snapshot
(`clients/review-graph/builder.ts` ~1961-2923 and `persist-worker.ts`) for one
project cache directory that N pi-lens processes share. It is adapted from
the project-snapshot promotion model of #3509. The `TLA+ models` CI job
(`node scripts/check-tla-models.mjs`) checks every config here against its
`\* expect:` line.

Issue: #3536.

## How it differs from the project-snapshot model

- There is no meta sidecar. `signature` and `fileSignatures` travel inside the
  body (`PersistedGraphData`, ~1752), so the body/meta pair of #3509 does not
  exist.
- Every `persistGraph` call takes a fresh generation (~2830-2836), and there
  is no one-active queue. Several requests can be in the worker at once, and
  the worker serves them concurrently: `serveGzipStageWorker` runs an async
  closure per message (`clients/gzip-stage-write.ts` ~178). Only the current
  generation promotes (~2376).
- A debounced `pending` slot coalesces persists (~2002).
- The sweep checks pid liveness (`isStaleReviewGraphStageFile`, ~2728).
- Builds whose `changedFiles` differ are not deduped (`buildCacheKey`, ~5967),
  so one process can run two builds of one workspace at once, and
  `persistGraph` runs at build end.
- `flushReviewGraphPersist` (the CLI and the exit hook, ~3485) forces a
  synchronous write of the newest pending or in-flight generation. Since
  #3536 it writes that candidate only when it is the current generation, and
  otherwise drops it unwritten.

## Invariants

- `NoSupersededPromotion`: only the current generation is ever written (the
  gate's promise, #1318/#1322).
- `InProcessLatestPersistWins`: a process never writes one of its own older
  generations over a newer one.
- `InProcessViewMonotone`: a process never writes an older view over a newer
  one that it already wrote.
- `NoRegression`: the body never goes back to an older view, across processes.
- `NoLiveStageLoss`: a sweep never removes a live sibling's stage file.
- `PersistDrains` (a liveness property, under `FairSpec`): every persist of a
  process that stays alive eventually leaves the pipeline. A crashed sibling
  never blocks it.

## Results

| Config | Verdict | Distinct states |
|---|---|---|
| `OneProcessFlush` (shipped code) | pass | 6,514 |
| `OneProcessFlushAnyGeneration` (mutant: the flush before #3536) | `NoSupersededPromotion` violated | |
| `OneProcessFlushFix` (crash and worker death, `FairSpec`) | pass, `PersistDrains` holds | 6,514 |
| `OneProcessNoGenGate` (mutant) | `InProcessLatestPersistWins` violated | |
| `OneProcessConcurrentBuilds` (shipped code) | `InProcessViewMonotone` violated | |
| `TwoProcesses` (shipped code, #3509 shape) | `NoRegression` violated | |
| `TwoProcessesCrashFlushFix` (crash and worker death, `FairSpec`) | pass, `PersistDrains` holds | 17,056 |
| `SweepNoLiveness` (mutant: the #3510 sweep) | `NoLiveStageLoss` violated | |

Before #3536, `OneProcessFlush` violated `NoSupersededPromotion` (a 13-state
trace); `OneProcessFlushAnyGeneration` keeps that behaviour as the mutant.

Run by hand, not in CI: `OneProcessFlushFix` with `Spec` in place of
`FairSpec` violates `PersistDrains`, so the property is not vacuous. The CI
checker only classifies invariant verdicts: a temporal violation reads as a
tool error there, which still fails a config that expects `pass`, so no
config expects a `PersistDrains` violation.

- **Flush wrote a superseded generation** (#3536, fixed). Generation 2
  promoted while generation 1 was still in the worker. The flush then picked
  the newest candidate of pending plus in-flight, which was generation 1, and
  wrote it over generation 2. The signatures inside the body stayed honest,
  so the next validated build re-diffed and repaired it. The cost was a
  rebuild. The regression test is in
  `tests/clients/review-graph-persist.test.ts`.
- **Concurrent builds** (`OneProcessConcurrentBuilds`, open). The build that
  started first finishes last and persists the older view. This is also
  cost-only, for the same reason.
- **Cross-process late loser** (`TwoProcesses`, open): the same cost-only
  outcome. The blind reader `getCachedReviewGraph` has no signature check, so
  it serves the older view. That is within its documented "possibly a few
  edits stale" contract.

## Scope

Not modelled:
- the checkpoint file, which has its own generation space;
- the legacy uncompressed body;
- pid reuse;
- a hung worker (the fairness assumes the worker replies);
- the async gap between `readdir` and `rm` in the sweep;
- `REVIEW_GRAPH_VERSION` skew between processes.

A body is identified by (owner, generation, view seq). Signature honesty is
covered in `formal/review-graph-signatures`.
