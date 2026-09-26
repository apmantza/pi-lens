# Snapshot freshness model

A TLA+ model of the seq-keyed freshness of the project snapshot when more than
one process records mutations for one project. The `TLA+ models` CI job checks
every config here against its `\* expect:` line.

Issue: #3511.

## What the model covers

- **Seed**: `session_start` replays `change-log.jsonl`
  (`readLatestProjectSequence`) and seeds `runtime.projectSeq`
  (`seedProjectSequence`). After a timed-out read, the late result folds into a
  session that already advanced (`mergeProjectSequence`). Either way the view
  then holds every logged entry and is complete again, and its fold point (the
  log entries it folded, `logEntries`) moves to the end of the log.
- **Cold seed** (`ColdSeeds`): a timed-out sequence read seeds projectSeq 0
  with an empty view and fold point 0.
- **Edit** (`recordProjectMutation` in `runtime-coordinator.ts`). Under the
  change-log lock, `appendProjectChangeAllocated` reads the log's max seq, and
  `bumpFileSeq` allocates `max(log max, own seq) + 1` (`LogAlloc`). A log max
  above the runtime's own seq means entries this runtime never folded; it
  records the highest one (`CompleteStamp`, `missing[p]`).
- **Unlocked edit** (`UnlockedEdits`, review round 2): when the change-log lock
  stays held past its 500 ms wait, the same edit is appended without it. The
  read of the log's max and the append are two steps, and every other process
  may act between them, so the seq can equal the one the lock holder logs. The
  entry is tagged `unlocked` in the log.
- **Save** (`saveRuntimeProjectSnapshot`, `buildProjectSnapshotFromRuntime`)
  stamps the runtime's real `projectSeq`, its view, its fold point, and
  `incomplete` when the view missed an entry. The promotion is the compare-and-set of
  `SnapshotPromotion.tla` (`SeqCAS`): a body lands unless the canonical one is
  at a higher seq. Its ordering is that model's subject; here it is atomic.

`incomplete` is a flag, not part of the compare-and-set key, in both models:
an incomplete view at a higher seq lands over a complete one at a lower seq,
and is never served fresh. A config with `LogAlloc` and `CompleteStamp`
`FALSE` models the code before #3511.

The reader rule (`ReaderRule`) is what `session_start` checks beyond the flag
and the seq. The code's rule, `"tag"`: a snapshot is not fresh, and its
`sequenceIndex` does not seed the bounded replay, while an `unlocked` entry
sits after its fold point. The runtime that folded such an entry at a seed or
merge vouches for it; any other may have missed it, even at the log's max seq.
`"none"` is the code before round 2, and `"dup"` is the review's first
prescription (distrust only a seq two entries share).

## Invariants

- `FreshMeansComplete`: a snapshot that `session_start` judges fresh (not
  incomplete, `snapshot.seq == log max`, and passing the reader rule) reflects
  every logged edit.
- `BoundedReplayExact`: the bounded replay equals the full replay. Only a
  complete snapshot that passes the reader rule seeds it.
- `FreshForOwnRuntime`: a runtime whose seq matches a complete snapshot's is
  not served one that lacks one of its own edits.
- `NewestSaveLands` (no drop, catalog shape 54): the canonical snapshot is
  never behind the newest view any process saved.
- `IncompleteOnlyWhenMissing`: a snapshot is marked incomplete only if its
  view really missed a logged entry at or below its seq.

The last two are the no-drop side (review round 1, M1). Without them, a fix
that never lets a save land, or never judges anything fresh, passes the first
three.

## Results

| Config | Verdict | States (distinct) |
|---|---|---|
| `OneWriter` (the code, one process, timed-out seeds) | pass | 195 (676 generated) |
| `TwoWriters` (the code, #3511) | pass; `FreshMeansComplete` violated before (4-state trace) | 205 (1,281 generated) |
| `TwoWritersReplay` (the code, #3511) | pass; `BoundedReplayExact` violated before | 205 (1,281 generated) |
| `Fix` (the code, two processes, timed-out seeds) | pass | 4,597 (29,765 generated) |
| `FixUnlockedAppend` (`Fix` with unlocked appends, three edits) | pass | 30,404 (138,969 generated) |
| `UnlockedNoReaderRule` (round-1 code, review round 2 R2-F1) | `FreshMeansComplete` violated | |
| `UnlockedDupAtSeq` (distrust only a shared seq) | `FreshMeansComplete` violated | |
| `FixNoLogAlloc` | `FreshMeansComplete` violated | |
| `FixNoCompleteStamp` | `FreshMeansComplete` violated | |
| `NeverSeqMutant` (round-0 design: stamp seq -1) | `NewestSaveLands` violated, one process | |
| `RefuseAllMutant` | `NewestSaveLands` violated | |
| `AlwaysIncompleteMutant` | `IncompleteOnlyWhenMissing` violated | |

Before the fix, with two writers, both processes allocated the same seq for
different edits. A snapshot that never saw the sibling's edit carried the
log's max seq, so `session_start` hydrated it as fresh, and the bounded replay
skipped the sibling's entry.

**The fix** has two parts, and removing either one fails `Fix`:
- **Log allocation** (`LogAlloc`): allocate the seq as
  `max(log max, own seq) + 1` under the append lock.
- **Incomplete flag** (`CompleteStamp`): a view that missed a logged entry at
  or below its seq stamps `incomplete`; it keeps its real seq.

The first design (round 0) stamped such a view with seq `-1` instead of a
flag. The compare-and-set then ranked it below every stamped snapshot, so it
never landed: `NeverSeqMutant` violates `NewestSaveLands` with one process,
through a timed-out seed followed by one edit (review round 1, B2).

Round 1 had the unlocked writer mark its own view incomplete, and nothing
else. `UnlockedNoReaderRule` finds the gap: the lock holder logs the same seq,
stays complete, and its snapshot is fresh without the unlocked edit. The
review's first prescription, `UnlockedDupAtSeq`, fails too: after the
collision the lock holder's next edit allocates one above it, so no seq its
snapshot carries is shared. The tag rule needs no self-mark: the unlocked
writer's own entry sits after its own fold point, so round 2 removed it.

The replays are in `tests/clients/project-snapshot-cross-process.test.ts`
(`project seq allocation across processes (#3511)`, with a real child `node`
process as the sibling) and, for the timed-out seed,
`tests/clients/runtime-session-sequence-read-budget.test.ts`.

## Scope

Not modelled:
- edits pi-lens never logs (an editor, `git checkout`), which seq freshness
  does not claim to see;
- the per-document mtime/size refresh of the word index, which repairs its
  own postings regardless of seq;
- a late read taken before an entry the edit missed (the merge keeps the
  incomplete mark then; tested, not modelled: the model's reads are atomic);
- writers from before #3511, which neither allocate from the log nor tag an
  unlocked append;
- log truncation.
