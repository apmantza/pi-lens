# Snapshot freshness model

A TLA+ model of the seq-keyed freshness of the project snapshot when more than
one process records mutations for one project. The `TLA+ models` CI job checks
every config here against its `\* expect:` line.

Issue: #3511.

## What the model covers

- **Seed**: `session_start` replays `change-log.jsonl`
  (`readLatestProjectSequence`) and seeds `runtime.projectSeq`
  (`seedProjectSequence`).
- **Edit** (`recordProjectMutation` in `runtime-coordinator.ts`). Under the
  change-log lock, `appendProjectChangeAllocated` reads the log's max seq and
  `bumpFileSeq` allocates `max(log max, own seq) + 1` (`LogAlloc`); the entry
  is appended in the same critical section. A log max above the runtime's own
  seq means a sibling logged entries this runtime never folded, and the
  runtime records that (`viewMissesLoggedEntries`).
- **Save** (`saveRuntimeProjectSnapshot`, `buildProjectSnapshotFromRuntime`)
  stamps `runtime.projectSeq` and the runtime's sequence index, or the
  never-fresh stamp when the runtime's view misses a logged entry
  (`CompleteStamp`). Promotion is atomic here; `SnapshotPromotion.tla`
  covers its ordering.

`LogAlloc` and `CompleteStamp` are `TRUE` in the code since #3511. A config
with them `FALSE` models the code before that fix, when `bumpFileSeq` only
incremented the in-memory seq and never read the log.

## Invariants

- `FreshMeansComplete`: a snapshot that `session_start` judges fresh
  (`snapshot.seq == log max`, `isProjectSnapshotFresh`) reflects every logged
  edit.
- `BoundedReplayExact`: the bounded replay equals the full replay
  (`partialReplay` in `project-changes.ts` claims this "under the append-only,
  single-writer invariant"). The bounded replay is the meta `sequenceIndex`
  plus the entries with `seq > snapshot.seq`.
- `FreshForOwnRuntime`: a runtime whose seq matches the snapshot's is not
  served a snapshot that lacks one of its own edits.

## Results

| Config | Verdict | States (distinct) |
|---|---|---|
| `OneWriter` (the code, one process) | pass; it passed before the fix too | 20 (55 generated) |
| `TwoWriters` (the code, #3511) | pass; `FreshMeansComplete` violated before (4-state trace) | 52 (231 generated) |
| `TwoWritersReplay` (the code, #3511) | pass; `BoundedReplayExact` violated before | 52 (231 generated) |
| `Fix` | pass | 754 (3,439 generated) |
| `FixNoLogAlloc` | `FreshMeansComplete` violated | |
| `FixNoCompleteStamp` | `FreshMeansComplete` violated | |

Before the fix, with two writers, both processes allocated the same seq for
different edits. A snapshot that never saw the sibling's edit carried the
log's max seq, so `session_start` hydrated it as fresh. The bounded replay
then skipped the sibling's entry, because its seq was at or below the
snapshot's.

**The fix** has two parts, and removing either one fails `Fix`:
- **Log allocation** (`LogAlloc`): allocate the seq as
  `max(log max, own seq) + 1` under the append lock.
- **Completeness stamp** (`CompleteStamp`): stamp a fresh seq only when every
  logged entry at or below it is in the runtime's own view; otherwise use a
  never-fresh stamp.

The model's never-fresh stamp is `Never == 999`; it only has to differ from
every log max. The code's is `PROJECT_SNAPSHOT_NEVER_FRESH_SEQ = -1`: below
every real seq, so the promotion compare-and-set of `SnapshotPromotion.tla`
never lets it block a stamped snapshot, and `isProjectSnapshotFresh` rejects
any negative seq, which also keeps it from matching `session_start`'s own
`-1` sentinel for a timed-out sequence read.

The replays are in `tests/clients/project-snapshot-cross-process.test.ts`
(`project seq allocation across processes (#3511)`); the sibling writer is a
real child `node` process.

## Scope

Not modelled:
- edits pi-lens never logs (an editor, `git checkout`), which seq freshness
  does not claim to see;
- the per-document mtime/size refresh of the word index, which repairs its
  own postings regardless of seq;
- the sequence-read timeout seed;
- a change-log lock held past its 500 ms wait: the code then appends without
  it, stamps that runtime's snapshots never-fresh until its next seed, and
  records `change-log-lock-unavailable`;
- log truncation.
