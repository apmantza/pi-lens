# Server content vs. disk model

A TLA+ model of one file's content as the language server holds it, compared
with the bytes on disk, while several pi-lens actors write and touch that
file at the same time. Each config's first line is its `\* expect:` verdict,
the same format `formal/file-locks/README.md` uses, and the `TLA+ models` CI
job (`node scripts/check-tla-models.mjs`) checks every config against it.

Issues: #3480 (the debounce fingerprint), #3481 (the stale cascade touch).

## What the model covers

- **Agent writes** `w1`/`w2`: the write tool lands its bytes (a new mtime).
  Then that edit's pipeline reads the file (`pipeline.ts` ~1349
  `readFileSync`) and calls `touchFile` (~1102, `lsp_sync`, scope
  `primary`). `write-ordering-guard.ts` ~6-13 allows two same-turn pipelines
  for one file to run concurrently.
- **The cascade neighbour reader** `cas`: `integration.ts` ~1972 reads the
  file, awaits `getCapabilitySnapshots`/`getClientForFile`, and then calls
  `touchFile` with what it read (~2009 tier-aware, ~2099 full wait).
- **`LSPService.touchFile`** (`lsp/index.ts`):
  - `startedAt` is taken when the call starts (~4640);
  - there is a per-server debounce check (`shouldSkipNotify`), with a
    1500 ms window and a whole-content fingerprint
    (`fingerprintDocumentContent`, `document-drift.ts` ~76; before #3480 it
    was length plus the first 48 and last 48 chars);
  - then `notify.open`;
  - after the write lands, `markTouched` (~5173) runs, and then
    `recordFullyCoveredSync(startedAt)` (~5199). A touch that skips the
    notify records nothing: the record call is inside `if (!notifySkipped)`.
- **The notify queue** (`client.ts` `enqueueDocumentNotify`):
  - the last enqueued entry replaces the unstarted one, and its waiters are
    carried to the replacement (before #3481; since #3481 a stamped entry
    replaces a stamped one only when it was read no earlier, and the runner
    drops an entry read before what it last sent for the path);
  - the first entry starts on a microtask;
  - the `for(;;)` loop takes the next entry in the same tick as the previous
    one settles;
  - waiters resolve in FIFO order;
  - the check and the send are one step.
- **The drift sweep** (`document-drift.ts` `runSweep` ~306-540):
  - a file is a candidate if `size` changed or `floor(mtime) > syncedAt`;
  - a candidate is read. If its fingerprint equals the record's, the record
    is re-stamped and nothing is sent. Otherwise the sweep calls `touchFile`
    (`drift_resync`, scope `all`, which uses its own debounce key) and
    stamps `settledStamp`.

Each `await` is a step boundary. The clock is logical, so no two stamps are
equal.

## Invariants

- `ServerMatchesDisk`: once every actor has finished, the queue is empty, and
  a sweep pass after that found nothing, the server holds exactly the bytes
  on disk.
- `SendsMonotone` (per send): the runner never replaces the server's content
  with *different* content that was read earlier than what it last sent.

## Results

| Config | Expect | TLC | States | s |
|---|---|---|---|---|
| `SingleWrite` | pass | pass | 799 | 1.2 |
| `CascadeResized` | pass | pass | 290,959 | 5.1 |
| `CascadeEqualLength` | pass (after #3481) | pass | 280,401 | 13.1 |
| `CascadeSendOrder` | pass (after #3481) | pass | 288,187 | 10.0 |
| `TwoWritesResized` | pass | pass | 1,712,166 | 18.1 |
| `TwoWritesEqualLength` | pass (after #3481) | pass | 1,596,714 | 29.2 |
| `DebounceLossyFp` | pass (after #3480) | pass | 1,256 | 1.2 |
| `DebounceFullFp` | pass | pass | 1,256 | 1.3 |
| `FixCascadeEqualLength` | pass | pass | 305,808 | 5.4 |
| `FixTwoWritesEqualLength` | pass | pass | 1,735,122 | 18.8 |
| `FixAllActors` | pass | pass | 855,661 | 11.9 |
| `MutFixNoDrop` | violated ServerMatchesDisk | violated | 84,614 | 2.8 |
| `MutFixNoCoalesce` | violated ServerMatchesDisk | violated | 49,710 | 2.4 |
| `MutCascadeResizedMtimeKey` | violated ServerMatchesDisk | violated | 47,644 | 2.4 |
| `ArtifactCascadeResizedAnyLanding` | violated ServerMatchesDisk | violated | 47,565 | 2.4 |

## Traces

**`CascadeEqualLength`: a stale cascade touch lands last** (before #3481,
with `FixCoalesce = FixDrop = FALSE`: violated in 40,995 states, and
`CascadeSendOrder` violated `SendsMonotone` in 2,597).

1. The cascade reads N (content A).
2. The agent writes B, which has the same length as A.
3. B's pipeline reads B, calls `touchFile`, and B's `didChange` is sent.
4. The cascade's `touchFile` starts after the write, so its `startedAt` is
   later than B's mtime. Its entry A queues behind B and is sent next.
5. Both touches land. The record ends as `(size(A), fp(A), syncedAt > mtime(B))`.

The size is unchanged and the mtime is older than `syncedAt`, so no sweep
ever flagged the file. The server kept A and the disk had B.

`CascadeResized` is the same interleaving with an edit that changes the
length. The size half of the key flags it, and the sweep resyncs. That
config passes only because of the size half:
`MutCascadeResizedMtimeKey` (mtime-only key) turns it red.

**`TwoWritesEqualLength`** (before #3481: violated in 201,988 states) had the
same shape with two same-turn pipelines.

1. Pipeline 1 reads B.
2. The agent writes C.
3. Pipeline 2 reads C and sends it.
4. Pipeline 1's entry (B) is sent after C.

The last send won, not the most recent read. #3481 shipped the fix below,
and the three configs now set `FixCoalesce = FixDrop = TRUE` and pass.

**`DebounceLossyFp`** (before #3480, `LossyFp = TRUE`: violated in 60
states) happened with no concurrency at all.

1. A touch of A landed less than 1.5 s ago.
2. The agent edits only the middle of the file. The file is longer than
   96 chars and the edit keeps its length.
3. `shouldSkipNotify` sees the same length+head+tail fingerprint and skips
   the notify. The touch records nothing.
4. The sweep flags the file on mtime, reads it, gets the same lossy
   fingerprint, and re-stamps it as `unchanged`.

The server kept A. #3480 made both fingerprints hash the whole text, so the
config now sets `LossyFp = FALSE` and passes.

**Model artifact (`ArtifactCascadeResizedAnyLanding`).** If two waiters of
one queue entry may finish in any order, the pipeline stamps the drift
record last even though the stale cascade content was sent. The record then
matches disk and hides the stale view, even when the length changed. The
code does not do this: `enqueueDocumentNotify` resolves waiters in FIFO
order, and both callers run the same `touchFile` continuation. The faithful
configs set `FifoLanding = TRUE`. A second artifact was also removed: in the
first draft the runner could start later than it does, which let an idle
queue's pending entry be replaced. The runner is now modelled as prompt, and
`PriorInFlight` provides the in-flight entry that makes replacement real.

## Replay on the real code

This is a throwaway vitest file, deleted from the repo after the run; #3480
and #3481 carry what their regression tests need. It uses the real `LSPService`. The
client's `notify.open` is the real `handleNotifyOpen`, so it goes through
the real `enqueueDocumentNotify` over `createMockState`'s mock connection.
`gatedPromise` holds B's send in flight while the cascade touch enqueues.
The test sleeps 1.6 s so that the priming touch is outside the debounce
window. Output:

```text
[replay equal-length] wire=["didOpen:A","didChange:B","didChange:A"] sweep={"candidates":0,"resynced":0,"unchanged":0} serverIsDisk=false
 × CascadeEqualLength: stale cascade touch lands last and the sweep cannot see it
[replay resized] wire=["didOpen:A","didChange:B","didChange:A","didChange:B"] sweep={"candidates":1,"resynced":1,"unchanged":0} serverIsDisk=true
 ✓ CascadeResized (control): the size key heals the same race
[replay debounce] sends=1 sweep={"candidates":0,"resynced":0,"unchanged":0} serverIsDisk=false
 × DebounceLossyFp: a middle-only edit inside the debounce window is never sent
```

In the debounce replay, the non-awaited sweep that `touchFile` fires had
already re-stamped the file as `unchanged`. So the forced pass sees no
candidate: a first run showed `candidates:1, unchanged:1`. The outcome is
the same either way.

What the replay does not drive: `integration.ts` itself. The cascade's
read-then-touch is called directly. Driving the real `computeCascade` needs
a reverse-dependency index fixture and a way to hold its
`getCapabilitySnapshots` await, and that was not worth building for this
check.

## The fix: last-READ-wins queue (#3481)

Each touch carries a read stamp: when the caller read the bytes. The code
uses `performance.now()` taken just before the read, passed down as the
`touchFile` option `readStamp`; the post-write pipeline and the cascade set
it. An unstamped touch coalesces as before (last enqueued wins) and never
moves the last-sent stamp. The fix has two parts:

1. **Coalesce by read order.** An unstarted entry is replaced only by one
   that was read no earlier (`FixCoalesce`).
2. **Drop stale entries.** The runner drops an entry whose read stamp is
   older than the content it last sent, and still resolves its waiters
   (`FixDrop`).

With both parts, `FixCascadeEqualLength`, `FixTwoWritesEqualLength` and
`FixAllActors` pass `ServerMatchesDisk` and `SendsMonotone`. Removing either
part breaks the fix:
- `MutFixNoDrop` is red: a stale entry that queues behind a newer one in
  flight is still sent.
- `MutFixNoCoalesce` is red: with an earlier notify in flight, stale A
  replaces pending B, and B is never sent.

One detail the model does not carry: a touch whose content was kept out or
dropped resolves `false` from `notify.open`, and `touchFile` then records
neither the debounce entry nor the drift record for it. The model's `Finish`
still stamps the record with the stale content; the code keeps the record on
the content the server holds, so a quick revert to the stale bytes is sent
rather than skipped as a repeat.

The lossy debounce has a separate fix, shipped in #3480: a full-content
fingerprint for `shouldSkipNotify`, and for the drift record's confirmation
read. `DebounceFullFp` and the flipped `DebounceLossyFp` pass.

## Scope and limits

- There is one server and one file. Auxiliary servers, partial coverage,
  write timeouts and deferral (#1459) are not modelled.
- Untracked (bash) edits are not modelled; the sweep exists for those.
  Git-seam resyncs are also not modelled.
- The drift resync's own debounce key (scope `all`) is taken to be never
  fresh.
- `boundToCurrentDisk` does not change the content invariant. On a versioned
  server, the stale view's diagnostics bind to hash(A), so they read `false`
  against disk and are demoted to inconclusive (the safe direction). On a
  version-less server they read `unknown`. In both cases the view stays
  stale until the file is touched again.
- The sweep is assumed to run eventually. In the code, it only runs when some
  touch or workspace diagnostics call fires its heartbeat.
- `floor(mtime)` ties within one millisecond are not modelled. They would
  widen the blind window.
