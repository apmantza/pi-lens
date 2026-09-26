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

Issue: #3535.

The disk holds a content version `c[f]` and a stat `st[f]` for each file. An
edit bumps both. A touch bumps only the stat. A write is either observed by a
pi session, which bumps that session's projectSeq, or external. Build steps
are interleaved with writes at every await:
- sweep: stat, then confirm, extract, install;
- seq fast path: candidates and their stat, then confirm, extract, install.

Persists land on the shared disk at any later time, so cross-process late
losers are included.

## Invariants

- `MemHonest` / `DiskHonest`: when an entry's `sig` or `hash` for a file
  matches the disk, the entry's content for that file is current.
- `NoStaleServedAsCurrent`: a validated reader never serves a stale entry as
  current. This covers the sweep's exact match, both in-process and from disk.
- `DiskNoRegression` exists for non-vacuity only: late losers are reachable.

## Results

| Config | Verdict | Distinct states |
|---|---|---|
| `SweepOnly` (two writers, late losers, no fast path) | pass | 86,095 |
| `SweepOnlyRegression` | `DiskNoRegression` violated | |
| `FastpathToday` (shipped code) | pass | 33,367 |
| `FastpathTodayDisk` (shipped code) | pass | 33,367 |
| `Fix` (two processes, one file) | pass | 173,030 |
| `FixTwoFiles` (one process, two files) | pass | 250,730 |
| `FixNoNoop` / `FixNoExtract` (mutants: one fix part undone) | `MemHonest` violated | |

Before #3535, `FastpathToday` violated `NoStaleServedAsCurrent` (a 12-state
trace), and `FastpathTodayDisk` violated `DiskHonest`. Run by hand, not in
CI: `FastpathTodayDisk` with both `FixFp*` constants `FALSE` still violates
`DiskHonest` (9,128 distinct states when the error is found), so its pass is
not vacuous.

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

## Scope

Not modelled:
- one build per process at a time (concurrent builds are covered in
  `review-graph-promotion`);
- file additions and removals (a removal falls through to a full build);
- the checkpoint resume;
- `file.content` supplied by the dispatch FactStore. On the fast path,
  `addFileToGraph` does not reuse it: with no content override it re-reads the
  file (`ensureReviewGraphFacts` runs the content provider), so the extracted
  bytes are never older than the confirm-time hash. The fact store is shared
  with the dispatch, though, so a concurrent same-file content-provider run
  could overwrite `file.content` between that read and the fact providers'
  reads. That interleaving is not checked here;
- content ABA (a file returning to an earlier byte sequence).

Only processes in `Observers` take the fast path, and only processes in
`Writers` persist. Both limits bound the state space.
