# Server content vs. disk model

A TLA+ model of one file's content as the language server holds it, compared
with the bytes on disk, while several pi-lens actors write and touch that
file at the same time. Each config's first line is its `\* expect:` verdict,
the same format `formal/file-locks/README.md` uses, and the `TLA+ models` CI
job (`node scripts/check-tla-models.mjs`) checks every config against it.

Issues: #3480 (the debounce fingerprint), #3481 (the stale cascade touch),
#4493 (the HEAD-move resync, `HeadMoveResync.tla` and `HeadMoveHookBound.tla`,
below), #4507 (the order of one bash command's writes, `BashWriteOrder.tla`,
below).

## What the model covers

- **Agent writes** `w1`/`w2`: the write tool lands its bytes (a new mtime).
  Then that edit's pipeline reads the file (`pipeline.ts`
  `readFileSync`) and calls `touchFile` (`lsp_sync`, scope
  `primary`). `clients/write-ordering-guard.ts` `WriteOrderingGuard` allows two same-turn pipelines
  for one file to run concurrently.
- **The cascade neighbour reader** `cas`: `clients/dispatch/integration.ts`
  `computeCascadeForFile` reads the
  file, awaits `getCapabilitySnapshots`/`getClientForFile`, and then calls
  `touchFile` with what it read (tier-aware, then a full wait).
- **`LSPService.touchFile`** (`lsp/index.ts`):
  - `startedAt` is taken when the call starts;
  - there is a per-server debounce check (`shouldSkipNotify`), whose
    evidence `ContentGate` selects: `"sent"` is the code after #4532 gap 9
    (the client's own record of the payload it last sent,
    `getSentContent`, written by `recordSentContent` in the send's
    continuation), `"window"` is the pre-#4532 gate (a 1500 ms window plus
    a whole-content fingerprint, `fingerprintDocumentContent`,
    `document-drift.ts`; before #3480 the fingerprint was length plus the
    first 48 and last 48 chars) and is today only the fallback for a client
    that cannot report a record, and `"lossy"` is a mutant;
  - then `notify.open`;
  - after the write lands, `markTouched` runs, and then
    `recordFullyCoveredSync(startedAt)`. A touch that skips the
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
- **The drift sweep** (`document-drift.ts` `runSweep`):
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
| `MutLossyFp` | violated ServerMatchesDisk (the code before #3480) | violated | 58 | 1.1 |
| `DebounceFullFp` | pass | pass | 1,256 | 1.3 |
| `FixCascadeEqualLength` | pass | pass | 305,808 | 5.4 |
| `FixTwoWritesEqualLength` | pass | pass | 1,735,122 | 18.8 |
| `FixAllActors` | pass | pass | 855,661 | 11.9 |
| `MutFixNoDrop` | violated ServerMatchesDisk | violated | 84,614 | 2.8 |
| `MutFixNoCoalesce` | violated ServerMatchesDisk | violated | 49,710 | 2.4 |
| `MutCascadeResizedMtimeKey` | violated ServerMatchesDisk | violated | 47,644 | 2.4 |
| `ArtifactCascadeResizedAnyLanding` | violated ServerMatchesDisk | violated | 47,565 | 2.4 |
| `GateSentOneWrite` | pass | pass | 740,162 | |
| `GateSentLossyFp` | pass | pass | 23,224 | |
| `GateSentReopen` | pass | pass | 72 | |
| `GateWindowReopen` | violated ServerMatchesDisk (the pre-#4532 gate) | violated | 36 | |
| `GateWindowRepush` | pass (the pre-fix gate; not a safety defect) | pass | 705,511 | |
| `MutGateLossyFp` | violated ServerMatchesDisk (the new guard by fingerprint) | violated | 2,047 | |

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
`touchFile` option `readStamp`. The post-write pipeline, the cascade, the
drift resync (stamped before the sweep's read, as the model's `res` actor
is), the dispatch runner and the tool-call auto-touch set it. An unstamped
touch (warm-ups, explicit queries, the workspace sweep) replaces a pending
entry as before but keeps that entry's stamp, and never moves the last-sent
stamp. An unstamped touch is not in the model: one that reads older bytes
and is sent between two stamped touches is still sent. The fix has two
parts:

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
- `Writes = 0` (no agent write) is a scenario bound the reopen configs use:
  a close-then-reopen of unchanged bytes is the schedule the gate's
  no-record branch exists for.
- `CloseDoc` requires an empty queue, which is the order the notify queue
  itself guarantees. The model keeps `lastSentSeq` across a close, while
  `closeDocument` deletes `sentReadStamps`; a stale read that survives a
  close and is then re-sent is #3477's schedule, not this gate's, and the
  reopen configs use `Writes = 0` so it cannot arise there.
- The per-server `recentTouches` entry is always present after the first
  landed touch; the code's 800-entry trim can remove one, which makes the
  gate push (the safe direction).
- The gate's record write lag is modelled (`Record`), but the send's own
  wire write and its record are the only two ordering steps: a second
  touch landing between them re-pushes identical bytes. Both gates do this
  and it is pre-existing; the model does not assert a cache state, so it
  does not red on it.

## The sent-content gate (#4532 gap 9)

`shouldSkipNotify` used to answer "the server already holds these bytes" from
elapsed time: a skip needed the previous push to be inside the 1500 ms window,
and only then compared fingerprints. A touch whose own work outlived the window
(an auxiliary spawn, a paced scanner write) therefore re-pushed byte-identical
content, and a `didChange` on unchanged bytes clears the server's cached
diagnostics and restarts work it had already finished (#4527 measured the
equivalent re-push as a 2335 ms cold `lsp_diagnostics_timeout` on clangd). It
was also wrong in the other direction: a document closed and reopened inside
the window was skipped, because the window was consulted before the record.

The gate now reads the client's own record of the payload it last sent
(`getSentContent`) and compares it with the touch's content exactly. The model
carries that record as `sentRec`, written by `Record` in the send's own
continuation — after the wire write, before the waiters resolve — so every
schedule below is checked with the record lagging the wire by one await. A
document with no record (never opened, or closed since) is always pushed, which
`CloseDoc` (#3477 `closeDocument`: a queue entry, so the model applies it only
with the queue idle) makes reachable.

Configs: `GateSentOneWrite` (one write, the cascade reader, an earlier notify in
flight), `GateSentLossyFp` (the same-length middle-only edit, the arm the
fingerprint gate lost) and `GateSentReopen` (the close-then-reopen direction)
run the as-built gate and pass. `GateWindowReopen` is red on the same reopen
schedule under the pre-#4532 gate: `recent` survives a `didClose`, so the reopen
is skipped and the server is left with no document at all for a file on disk.
`MutGateLossyFp` is the new guard mutated to compare the record by fingerprint
rather than by content, and is red.

Two things the model says plainly:

- The re-push direction is an efficiency claim, not a safety one. A redundant
  `didChange` leaves `server = disk`, so `GateWindowRepush` passes: the model
  cannot red it, and `tests/clients/lsp/touch-debounce-content-gate.test.ts`
  carries that half by tracing the wire.
- Mutating the gate back to `recent.fresh` cannot red either: skipping less
  never installs stale bytes, so no invariant here can catch it. The
  fingerprint comparison is the mutation that reds (`MutGateLossyFp`).

`MutFixNoCoalesce` now runs under `ContentGate = "window"`: under the
sent-content gate a stale touch whose bytes are the ones already sent is
skipped before it can replace a pending entry, so #3481's coalescing half is no
longer load-bearing in this model for that schedule.

## HeadMoveResync: held documents across a HEAD move (#4493)

`HeadMoveResync.tla` models what the server holds after HEAD moves on a
clean tree. A checkout, `reset --hard`, or a completed rebase or cherry-pick
leaves `git status` empty, so opaque recovery (the dirty set) never saw it,
and the server kept the pre-move bytes of every held document.

### What the model covers

- **Two sessions, one server.** One `LSPService` and one
  `RuntimeCoordinator` serve the primary and a concurrent secondary, so they
  share the scan slot. Each session runs two bash calls in parallel.
- **Moves.** A call's command may check out (the held documents' bytes
  change), commit (HEAD moves, the bytes stay), or do neither. An outside
  move (a terminal, an IDE) does either with no tool event.
- **Looks** (`resyncHeadMove`, at every `tool_call` and every bash
  `tool_result`). A look has three steps, with each `await` a boundary:
  1. `Read` takes HEAD. Since round 2 that is a file read with no await
     before `Cas`, and `git rev-parse` (awaited) only when the files cannot
     answer (a reftable ref store); the model keeps the await, a superset.
  2. `Cas` is `observeGitHead`, a synchronous compare-and-set on the
     session's record.
  3. `Resync` runs only when `Cas` reported a move. It resends the held
     documents in the delta whose sent bytes differ from the disk, up to
     `Cap`, reading the disk as it is at that moment, and writes the one
     `opaque_mutation_head_moved` row. In the code that is two phases (the
     primary servers inside the look, then `resyncGitChangedFiles` with
     forced passes after it, which writes the row); this model collapses
     them into one step, and `HeadMoveHookBound.tla` splits them.
- **Serialization.** Looks of one key run one at a time (`Serial`): the code
  runs them under a coalescing `createSingleFlight` per key.

The model does not cover the 500 ms hook bound, primary versus auxiliary
servers, or a non-bash tool reading the view; `HeadMoveHookBound.tla` does.

### Invariants

- `HeldFreshWhenQuiet`: no look is in flight, and a hook ran after the
  latest move. Then every held document's server bytes equal the disk, or
  that move's row states the drain cap's remainder.
- `OneRowPerEvent`: no row reports a HEAD moving to itself, and no session
  writes two rows for one transition.
- `SessionIsolation`: no record is written by looks of two sessions.
- `NoRedundantSend`: no resync resends bytes the server already holds.

### Results

TLC 1.7.4, one worker, `MaxMoves = 2`, `Outside = TRUE`.

| Config | Expect | TLC | Distinct states | s |
|---|---|---|---|---|
| `HeadMovePreFix` (`Track = FALSE`) | violated HeldFreshWhenQuiet | violated | 8 | 0.7 |
| `HeadMoveFix` | pass | pass | 1,260,722 | 17.0 |
| `HeadMoveFixCapped` (`Cap = 1`) | pass | pass | 1,685,552 | 22.9 |
| `HeadMoveMutNoReport` | violated HeldFreshWhenQuiet | violated | 454 | 0.7 |
| `HeadMoveMutSlotKey` | violated SessionIsolation | violated | 670 | 0.7 |
| `HeadMoveMutNoCompare` | violated OneRowPerEvent | violated | 89 | 0.7 |
| `HeadMoveMutResendAll` | violated NoRedundantSend | violated | 449 | 0.7 |
| `HeadMoveMutNoSerial` | violated OneRowPerEvent | violated | 79,998 | 1.7 |
| `HeadMoveWarmupGap` (`InitRec = FALSE`) | violated HeldFreshWhenQuiet | violated | 159 | 0.7 |

**`HeadMoveMutNoSerial`: a record regresses.** This is the trace that led
to the per-key single-flight. The first draft of the fix let a session's
looks run concurrently.

1. Look 1 (call 1's `tool_call`) reads HEAD 0.
2. An outside move takes HEAD to 1.
3. Look 2 (call 2's `tool_call`) reads 1. Its `Cas` sets the record from 0
   to 1 and reports the move.
4. Look 1's `Cas` runs last. It sets the record back to 0 and reports a
   move from 1 to 0.
5. A later look reads 1 and reports the move from 0 to 1 a second time.

No document stays stale, because the resync resends only stale bytes. The
row stream is wrong, though, and the record disagrees with HEAD.

**`HeadMoveWarmupGap` is the residual as built.** A move before a session's
first look is recorded as the session's first HEAD, not as a move. A
document opened before that first look keeps the pre-move bytes until the
drift heartbeat. The #4493 PR names this residual.

## HeadMoveHookBound: what the next tool sees when a hook is cut (#4493 r2)

Review r1 F1 found the reported STOP still firing after a 13-file checkout on
the default stack (typescript plus the ast-grep auxiliary): the tool_result
returned at its 500 ms bound with `lib/types.ts` stale on the primary.
`HeadMoveResync.tla` checked freshness only once every look had returned,
so it had no state where a hook is cut while its look runs on.

### What the model covers

- **One session, two parallel tool calls** of one message: bash `B`, whose
  command checks out the other branch (both held documents change), and `E`,
  a read or edit whose dispatch reads the primary's view.
- **Two views per document**: the primary `P` and an auxiliary scanner `X`.
- **The look** reads HEAD and compares in one step, then owes sends:
  `lookQ`, which the waiting hooks wait for, and `tailQ`, detached after it.
  `PrimaryFirst = TRUE` is the fix (`resyncHeldPrimaries` in the look, then
  `resyncGitChangedFiles` detached); `FALSE` is round 1 (every server per
  document inside the look, the drift resync's `clientScope: "all"`).
- **The bound.** An auxiliary send can stall (the #1714 pacing barrier, up
  to 2 s); a primary send cannot. A hook waiting on a look may return at its
  bound only while the look's next send is auxiliary. Assumption: one look's
  primary sends fit in the bound; a longer primary phase is disclosed by the
  `hook-await-exceeded` row and the head_moved counts, and is not modelled.
- **Joining.** `Join = TRUE` is the fix: every tool_call looks, joins a look
  in flight and reads HEAD again when it ends. `FALSE` is round 1: a
  non-bash tool_call skipped the look once the turn was marked.

### Invariants

- `EditSeesFreshPrimary`: a tool call that began after the move never reads
  a stale primary.
- `SettledFresh`: once every send has run and the move was observed, both
  servers hold the disk bytes.

### Results

TLC 1.7.4, one worker.

| Config | Expect | TLC | Distinct states |
|---|---|---|---|
| `HookBoundFix` | pass | pass | 82 |
| `HookBoundPreFix` (`PrimaryFirst = Join = FALSE`) | violated EditSeesFreshPrimary | violated | 13 |
| `HookBoundMutInterleaved` (`PrimaryFirst = FALSE`) | violated EditSeesFreshPrimary | violated | 28 |
| `HookBoundMutNoJoin` (`Join = FALSE`) | violated EditSeesFreshPrimary | violated | 13 |

**`HookBoundMutInterleaved`**: B's command moves HEAD; E's tool_call starts
the look; the look sends `P d1` and stalls at `X d1`; the bound returns E;
E reads the primary with `d2` stale. This is the live F1 run.

## The order of one bash command's writes (#4507)

`BashWriteOrder.tla`: a command rewrites a held dependency `z` and a held
dependent `a` that imports a name the command adds to `z`. The tool_result
dispatches each written file in turn, in either order; a dispatch sends its
file and reads the primary's check of it, which reads every held view.
`WritesPrimaryFirst` TRUE is the #4507 fix: the written held documents go to
the primary first, one at a time (`sendToHeldPrimaries`). `DispatchWaitsPhase`
TRUE is the #4528 r1 F1 fix: the dispatch loop waits for that phase under the
edit budget. FALSE is round 1, where a 500 ms bound could end the wait
(`PhaseCut`) while the phase still sent, and the dependent was checked before
the dependency's new bytes went out. A primary may wedge at any time (`Wedge`):
its views stop changing and it answers no check. Under `DispatchWaitsPhase`
only a wedged primary outlasts the wait (`EditCut`); the model assumes a live
primary takes the capped sends inside the edit budget.

- `NoPhantomFinding`: no dispatch checks a file against a held document's old
  bytes.
- `SettledFresh`: once the result is done, a live primary holds the disk
  bytes.

| Config | Expect | TLC | States |
|---|---|---|---|
| `BashWriteFix` | pass | pass | 62 |
| `BashWritePreFix` | violated NoPhantomFinding (before #4507) | violated | 6 |
| `BashWritePhaseCut` | violated NoPhantomFinding (#4528 r1, the 500 ms cut) | violated | 15 |

Round 3 (#4528): `ReplyOrdering` distinguishes measured single-task replies
from replies that may overtake queued didChanges. `RequireOrderedDrain` keeps
the latter phases undrained; `DrainProven` requires every claimed drain to
follow the reads. `BashWriteThreaded` checks that invariant;
`BashWriteThreadedPreFix` disables the guard and expects a violation.
Dispatch still runs after an undrained phase, so those configs do not claim
`NoPhantomFinding`. TLC was not run locally in round 3 (java unavailable);
the previous state counts above have not been remeasured.
