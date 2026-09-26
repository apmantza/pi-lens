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

- **Save** (`saveProjectSnapshot`, ~1780-1880). When the durable meta's seq
  differs, admission writes the meta sidecar first (~1815). Admission then
  picks the generation (the same seq keeps the same generation,
  ~1849-1854). It dispatches the request, or queues it behind the one active
  persist for the key (~1867-1875).
- **The worker** (`writeGzipStageFile` in `gzip-stage-write.ts`). It writes a
  tmp file and renames it to `<gz>.stage-<pid>-<gen>`.
- **Promotion** (`handleSnapshotWorkerResult`, ~1474-1580), in this order:
  1. the generation gate (~1502);
  2. `renameSync(stage, gz)` (~1555);
  3. `finalizeProjectSnapshotMeta` (~1557);
  4. `completeSnapshotPersist`, which dispatches the queued request.

  A missing stage (ENOENT) falls back to the synchronous main-thread writer
  (~1573-1578). Steps 2-4 are synchronous, so the model blocks the process's
  other main-thread actions between them (`Busy`). Other processes can still
  interleave.
- **The stage sweep** (`sweepStaleSnapshotStageFiles`, ~1719-1736). It runs
  once per process after its first save and removes every stage file whose
  name does not carry the process's own pid.
- **Crash**: a dead process leaves its stage files on disk.
- **`SessionReset`** (mutant only): a `session_start` that clears the
  generation map and the active slot while a request is still in the worker.
  The code does not do this. `tests/support/session-state-registry.ts` pins
  the coordinator as process-lifetime state ("a session reset must not
  abandon an in-flight durable publication").

## Invariants

- `NoSupersededPromotion`: a process never promotes a view after admitting a
  newer one (the gate's promise, #1322).
- `InProcessLatestWins`: a process never puts one of its own older saves over
  a newer one it has already promoted (catalog shape 21, inside one process).
- `NoRegression`: the canonical body never goes back to an older tree view
  (shape 21, across processes).
- `MetaNotBehindBody`: the meta seq is never behind the body's.
  project-snapshot.ts ~1797-1808 gives this as the reason the meta is written
  first. With an old-seq meta over a fresh body, the meta gate throws the
  body away without reading it.
- `NoLiveStageLoss`: no other process removes a live process's staged body
  before it is promoted.

## Results

| Config | Verdict | States (distinct) |
|---|---|---|
| `OneProcess` (today, crash allowed) | pass | 846 (1,444 generated) |
| `OneProcessNoGenGate` (mutant: no gate) | `NoSupersededPromotion` violated | |
| `OneProcessNoSingleActive` (mutant: no one-active queue) | `InProcessLatestWins` violated | |
| `SessionResetMutant` | `InProcessLatestWins` violated | |
| `TwoProcesses` (today) | `NoRegression` violated | 8-state trace |
| `TwoProcessesMeta` (today) | `MetaNotBehindBody` violated | 6-state trace |
| `SiblingSweep` (sweep skips live pids, #3510) | pass; `NoLiveStageLoss` violated before (6-state trace) | |
| `Fix` (two processes, crash allowed) | pass | 109,396 (342,981 generated, ~10 s) |
| `FixNoPromoteCAS`, `FixUnlocked` | `NoRegression` violated | |
| `FixNoAdmissionCAS` | `MetaNotBehindBody` violated | |
| `FixNoSweepLiveness` | `NoLiveStageLoss` violated | |

Inside one process the guards hold, and each one is needed:
- Without the generation gate, the queue still orders the final body. A
  superseded view is promoted for a moment, which is what the #1322 mutation
  test observes.
- Equal-seq saves share a generation, so the gate alone cannot order them.
  The one-active queue has to.

Across processes nothing orders promotions:
- **Late loser** (`TwoProcesses`). Process M admits its seq-1 view, and
  process P admits seq 2 and promotes it. M's slow worker then renames the
  seq-1 body over P's seq-2 body, and M's finalize writes meta seq 1.
- **Stale admission** (`TwoProcessesMeta`). P has promoted seq 2. M admits
  its seq-1 view, and the meta-first write sets meta to 1 over the seq-2
  body.
- **Sibling sweep** (`SiblingSweep`). P2's first save runs the sweep, which
  removes P1's in-flight `stage-<pid1>-<gen>`. P1's rename then fails with
  ENOENT and falls back to the synchronous main-thread gzip. The review-graph
  sweep already checks liveness (`isStaleReviewGraphStageFile`, #1206/#1228).

**The candidate fix** has three parts:
- **Promotion compare-and-set** (`PromoteCAS`): under the cache-dir lock,
  promote only if `meta.seq <= own seq`; otherwise drop the stage.
- **Admission compare-and-set** (`AdmissionCAS`): the meta-first write only
  raises the meta seq.
- **Atomicity** (`CASAtomic`): the check, the rename and the meta write
  happen in one critical section.

The sweep also skips pids that are still alive (`SweepLiveness`).

## Scope

Not modelled:
- the `skippedUnchanged` path and the #2008 integrity check (they write
  neither body nor meta);
- worker death and the exit hook (both re-dispatch through the same gated
  sync writer);
- the authoritative in-process cache;
- the legacy uncompressed body;
- the async gap between the sweep's `readdir` and its `rm`, which only widens
  `NoLiveStageLoss`;
- pid reuse.

Readers are not actors: `body` and `meta` are each replaced by rename, so a
torn file is not a reachable state in this encoding. The meta/body pair is
not atomic, and the invariants above check the pair.

A hung worker (one that never replies and never exits) leaves the key's
active slot held forever. Every later save for that key queues, and only the
exit hook writes it. This is a liveness property; the safety model does not
check it.
