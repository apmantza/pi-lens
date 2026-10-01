# Review-graph signature honesty model

Do the review graph's source signatures ever claim content that the graph did
not read? Each entry, in memory or in `review-graph.json.gz`, carries three
per-file maps: `content` (what was extracted), `sig` (`size:mtimeMs`) and
`hash` (sha256). Readers trust those claims in two places:
- the sweep path serves an entry unchanged when every stat equals `sig`
  (`_doBuildGraph` in `clients/review-graph/builder.ts`);
- the incremental path reuses a file's nodes when its current hash equals
  `hash` (`confirmContentChanged`).

The `TLA+ models` CI job (`node scripts/check-tla-models.mjs`) checks every
config here against its `\* expect:` line.

Issues: #3535, #3552 (fixed by #3746).

The disk holds a content version `c[f]` and a stat `st[f]` for each file. An
edit bumps both. A touch bumps only the stat. A write is either observed by a
pi session, which bumps that session's projectSeq, or external. Build steps
are interleaved with writes at every await:
- sweep: stat, then confirm, extract, install;
- seq fast path: candidates and their stat, then confirm, extract, install.

Persists land on the shared disk at any later time, so cross-process late
losers are included.

## Extraction is not atomic (#3552)

`addFileToGraph` builds a run-local `FactStore` for one file per run
(`#3552`), and `ensureReviewGraphFacts` reads the file's content, then its
imports and symbols, in separate awaits. On the pre-#3552 shared store a
same-file dispatch that lands between those reads replaces the record with its
own (newer) version, so one node records its content from one version and its
derived facts from another. The model splits the old atomic `Extract` into
`ReadContent`, `DispatchWrite` and `ReadFacts` to expose that window; the
`SharedStore` constant selects the run-local store (`FALSE`, merged #3552,
PR #3746) or the pre-fix shared store (`TRUE`).

The `SharedStore = FALSE` case is the model's assumption, not a checked fact:
the model takes as given that `addFileToGraph` extracts on the per-run local
`FactStore` (#3552), so `ReadFacts` reads back only the version `ReadContent`
recorded and `mixed` stays FALSE by construction. `NodeSingleVersion`
therefore passes on the merged config because of that assumption;
`SharedStore = TRUE` drops it and models the pre-fix shared store that the
runtime no longer uses.

## Invariants

- `MemHonest` / `DiskHonest`: when an entry's `sig` or `hash` for a file
  matches the disk, the entry's content for that file is current.
- `NoStaleServedAsCurrent`: a validated reader never serves a stale entry as
  current. This covers the sweep's exact match, both in-process and from disk.
- `NodeSingleVersion`: every node records its content and its derived
  (imports/symbols) facts from one content version. The run-local store makes
  this structural; the pre-fix shared store does not.
- `DiskNoRegression` exists for non-vacuity only: late losers are reachable.

## Results

| Config | Verdict | Distinct states |
|---|---|---|
| `SweepOnly` (two writers, late losers, no fast path) | pass | 347,835 |
| `SweepOnlyRegression` | `DiskNoRegression` violated | |
| `FastpathToday` (shipped code; merged #3552 run-local store) | pass | 66,570 |
| `FastpathTodayDisk` (shipped code) | pass | 66,570 |
| `Fix` (two processes, one file) | pass | 671,706 |
| `FixTwoFiles` (one process, two files) | pass | 567,120 |
| `FixNoNoop` / `FixNoExtract` (mutants: one fix part undone) | `MemHonest` violated | |
| `SharedStore` (pre-#3552 shared store) | `NodeSingleVersion` violated | |

The split's `SD` and `mixed` state inflates the pre-split configs'
distinct-state counts 2–4× (`SweepOnly` 86,095 → 347,835, `Fix` 173,030 →
671,706, `FastpathToday` 33,367 → 66,570, `FixTwoFiles` 250,730 → 567,120);
their verdicts are unchanged.

Before #3535, `FastpathToday` violated `NoStaleServedAsCurrent` (a 12-state
trace), and `FastpathTodayDisk` violated `DiskHonest`. Run by hand, not in
CI: `FastpathTodayDisk` with both `FixFp*` constants `FALSE` still violates
`DiskHonest` (9,128 distinct states when the error is found), so its pass is
not vacuous.

`FastpathToday` passes `NodeSingleVersion` by the run-local-store assumption;
`SharedStore` violates it on a six-state trace, so the invariant is not
vacuous:

```text
StartSweep -> ReadContent (X[f1] = 1) -> Write (c[f1] = 2) ->
DispatchWrite (SD[f1] = 2) -> ReadFacts (mixed = TRUE)
```

The derived read recorded version 2 while the content read recorded version 1:
one node spans two versions.

- **The sweep and incremental paths are honest.** They record the stat taken
  at build start, before any read, so a signature can only lag the content.
  A late-loser snapshot is therefore always re-diffed. This confirms the claim
  that cross-process regressions cost only a rebuild.
- **The seq fast path was not honest before #3535.** It re-statted its
  candidates after it had read them, in both the no-op branch and the
  re-extract branch. A write that landed in between got a signature the graph
  never read. The next sweep-path build matched it and served the stale graph
  as current, and the snapshot on disk carried the lie to every other process.
- **The fix** (#3535) records the candidates' stats before
  `confirmContentChanged` (`candidateStats` in `trySeqFastpath`) and installs
  those stats in both branches. The model takes that stat at `StartFastpath`,
  before `Confirm`. The regression tests pin both the "before the read" and
  the "before the hash" halves:
  `tests/clients/review-graph-seq-fastpath.test.ts` and
  `tests/clients/review-graph-seq-fastpath-hash-read.test.ts`.
- **The shared-store mix was structural before #3552.** With one shared
  `FactStore`, the graph's content read and its derived read could straddle a
  dispatch, and one node could record two versions. The run-local store
  (`FastpathToday`) removes the graph from the shared store's writers, so the
  dispatch is invisible. The boundary is pinned by
  `tests/clients/review-graph/dispatch-content-overwrite.test.ts`.

## Scope

Not modelled:
- one build per process at a time (concurrent builds are covered in
  `review-graph-promotion`);
- file additions and removals (a removal falls through to a full build);
- the checkpoint resume;
- `captureReviewGraphStructuralIr`'s read-only borrow of the scanner's store:
  the borrow is gated on `file.content` equalling the captured bytes, and it
  never writes the scanner's store, so it cannot make a node span versions;
- content ABA (a file returning to an earlier byte sequence).

The `DispatchWrite` action models a same-file dispatch landing during one
build's content-to-derived window; a dispatch outside that window changes no
node in the model. Only processes in `Observers` take the fast path, and only
processes in `Writers` persist. Both limits bound the state space.
