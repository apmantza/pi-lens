# Snapshot promotion model

A TLA+ model of the worker-thread persist of the project snapshot body
(`clients/project-snapshot.ts`, #958 item 2) for one project cache directory
that N pi-lens processes share. Examples are a pi session and the MCP server
(the word-index cold build in `clients/word-index.ts` calls
`saveProjectSnapshot`), or two pi sessions in one checkout. The `TLA+ models`
CI job (`node scripts/check-tla-models.mjs`) checks every config here against
its `\* expect:` line.

Issues: #3509 (cross-process promotion), #3510 (the stage sweep).

## What the model covers

- **Save** (`saveProjectSnapshot`). Admission writes the meta sidecar first,
  under the cache-dir lock, and only when that raises the durable meta's seq
  (`AdmissionCAS`). Admission then picks the generation (the same seq keeps
  the same generation). It dispatches the request, or queues it behind the one
  active persist for the key.
- **The worker** (`writeGzipStageFile` in `gzip-stage-write.ts`). It writes a
  tmp file and renames it to `<gz>.stage-<pid>-<gen>`.
- **Promotion** (`handleSnapshotWorkerResult`, then `promoteSnapshotBody`),
  in this order:
  1. the generation gate;
  2. under the cache-dir lock (`withGenerationLockSync`, the TLC-checked
     `clients/generation-lock.ts`): read the durable meta; if its seq is ahead
     of this save's, drop the stage (`PromoteCAS`); otherwise
     `renameSync(stage, gz)` and `finalizeProjectSnapshotMeta`. The check, the
     rename and the meta write are one critical section (`CASAtomic`);
  3. `completeSnapshotPersist`, which dispatches the queued request.

  A missing stage (ENOENT) falls back to the synchronous main-thread writer,
  which publishes through the same `promoteSnapshotBody`. Steps 2-3 are
  synchronous, so the model blocks the process's other main-thread actions
  between them (`Busy`). Other processes can still interleave.
- **The stage sweep** (`sweepStaleSnapshotStageFiles`). It runs once per
  process after its first save and removes every stage file whose embedded
  pid is dead (`isStaleStageFile`, shared with the review graph;
  `SweepLiveness`).
- **Crash**: a dead process leaves its stage files on disk.
- **`SessionReset`** (mutant only): a `session_start` that clears the
  generation map and the active slot while a request is still in the worker.
  The code does not do this. `tests/support/session-state-registry.ts` pins
  the coordinator as process-lifetime state ("a session reset must not
  abandon an in-flight durable publication").

The fix constants (`SweepLiveness`, `PromoteCAS`, `AdmissionCAS`,
`CASAtomic`) are `TRUE` in the code since #3509/#3510. A config with them
`FALSE` models the code before those fixes.

## Invariants

- `NoSupersededPromotion`: a process never promotes a view after admitting a
  newer one (the gate's promise, #1322).
- `InProcessLatestWins`: a process never puts one of its own older saves over
  a newer one it has already promoted (catalog shape 21, inside one process).
- `NoRegression`: the canonical body never goes back to an older tree view
  (shape 21, across processes).
- `MetaNotBehindBody`: the meta seq is never behind the body's. The
  admission comment in `saveProjectSnapshot` gives this as the reason the
  meta is written first. With an old-seq meta over a fresh body, the meta gate
  throws the body away without reading it.
- `NoLiveStageLoss`: no other process removes a live process's staged body
  before it is promoted.
- `NoDrop` (no drop, catalog shape 54; review round 1, M1): once every live
  process is idle, the body is at least as new as each live process's latest
  save. A refusal is only ever a loss to a body that landed or will land.
  Without it, a promotion that refuses every save passes every other
  invariant (`FixRefuseAll`).

## Results

| Config | Verdict | States (distinct) |
|---|---|---|
| `OneProcess` (in-process guards, fix constants off, crash allowed) | pass | 846 (1,444 generated) |
| `OneProcessNoGenGate` (mutant: no gate) | `NoSupersededPromotion` violated | |
| `OneProcessNoSingleActive` (mutant: no one-active queue) | `InProcessLatestWins` violated | |
| `SessionResetMutant` | `InProcessLatestWins` violated | |
| `TwoProcesses` (the code, #3509, with `NoDrop`) | pass; `NoRegression` violated before (8-state trace) | 468 (1,341 generated) |
| `TwoProcessesMeta` (the code, #3509, with `NoDrop`) | pass; `MetaNotBehindBody` violated before (6-state trace) | 468 (1,341 generated) |
| `SiblingSweep` (the code, #3510) | pass; `NoLiveStageLoss` violated before (6-state trace) | 97 (205 generated) |
| `Fix` (two processes, crash allowed) | pass | 109,396 (342,981 generated, ~10 s) |
| `FixNoCrash` (two processes, every invariant including `NoDrop`) | pass | 32,085 (120,909 generated) |
| `FixRefuseAll` (every promotion refused) | `NoDrop` violated | |
| `FixCrashDrop` (`Fix` with `NoDrop`) | `NoDrop` violated: the known crash residual below | |
| `FixNoPromoteCAS`, `FixUnlocked` | `NoRegression` violated | |
| `FixNoAdmissionCAS` | `MetaNotBehindBody` violated | |
| `FixNoSweepLiveness` | `NoLiveStageLoss` violated | |

**Known residual (`FixCrashDrop`).** p2's admission raises the meta to 2, p1's
seq-1 promotion is refused, and p2 dies before promoting. p1's save is then
refused until some save at seq 2 or above lands. In the code a dead process's
seq was allocated from the change log, so the next logged edit in any process
allocates above it; the loss is p1's snapshot content until then, not a wrong
freshness verdict. `NoDrop` holds whenever no process dies (`FixNoCrash`).

The seq in this model is a view seq. #3511 keeps it the order key: a view that
missed a logged entry is stamped `incomplete` as a separate flag (see
`../snapshot-freshness/`), so it takes part in the compare-and-set at its real
seq and still lands.

Inside one process the guards hold, and each one is needed while the fix
constants are off:
- Without the generation gate, the queue still orders the final body. A
  superseded view is promoted for a moment, which is what the #1322 mutation
  test observes.
- Equal-seq saves share a generation, so the gate alone cannot order them.
  The one-active queue has to.

With the fix constants on, the promotion compare-and-set also refuses a
superseded view of a lower seq, so `OneProcessNoGenGate` with them on passes
(405 states). In the code the gate still stands alone when the admission meta
write was skipped because another process held the cache lock past its wait;
the model has no lock timeout, and the #1322 mutation test in
`tests/clients/project-snapshot.test.ts` sets up exactly that state.

Before the fix, nothing ordered promotions across processes:
- **Late loser** (`TwoProcesses`). Process M admits its seq-1 view, and
  process P admits seq 2 and promotes it. M's slow worker then renamed the
  seq-1 body over P's seq-2 body, and M's finalize wrote meta seq 1.
- **Stale admission** (`TwoProcessesMeta`). P has promoted seq 2. M admits
  its seq-1 view, and the meta-first write set meta to 1 over the seq-2
  body.
- **Sibling sweep** (`SiblingSweep`). P2's first save ran the sweep, which
  removed P1's in-flight `stage-<pid1>-<gen>`. P1's rename then failed with
  ENOENT and fell back to the synchronous main-thread gzip.

**The fix** has three parts, and removing any one of them fails `Fix`:
- **Promotion compare-and-set** (`PromoteCAS`): under the cache-dir lock,
  promote only if `meta.seq <= own seq`; otherwise drop the stage.
- **Admission compare-and-set** (`AdmissionCAS`): the meta-first write only
  raises the meta seq.
- **Atomicity** (`CASAtomic`): the check, the rename and the meta write
  happen in one critical section.

The sweep also skips pids that are still alive (`SweepLiveness`).

The replays are `tests/clients/project-snapshot-cross-process.test.ts`: the
parent process is parked at `setProjectSnapshotPromotionSeamForTests` with its
body staged, and a real child `node` process is the sibling writer.

## Scope

Not modelled:
- the `skippedUnchanged` path and the #2008 integrity check (they write
  neither body nor meta);
- worker death and the exit hook (both re-dispatch through the same gated
  sync writer);
- the authoritative in-process cache (a refused save drops its own entry, so
  in-process readers see the sibling's body; tested in
  `after a refusal, in-process readers and merge-writers build on the sibling's newer body (#3509)`);
- the legacy uncompressed body;
- the async gap between the sweep's `readdir` and its `rm`, which only widens
  `NoLiveStageLoss`;
- a cache lock that stays held past its 500 ms wait (the code drops that
  save as a failed persist and records `project-snapshot-lock-unavailable`);
- pid reuse.

Readers are not actors: `body` and `meta` are each replaced by rename, so a
torn file is not a reachable state in this encoding. The meta/body pair is
not atomic, and the invariants above check the pair.

A hung worker (one that never replies and never exits) leaves the key's
active slot held forever. Every later save for that key queues, and only the
exit hook writes it. This is a liveness property; the safety model does not
check it.
