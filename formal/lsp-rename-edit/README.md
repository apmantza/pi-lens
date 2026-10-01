# LSP rename edit model

A TLA+ model of a language server's `WorkspaceEdit` being applied to files
that may have changed since the server computed it (#3803 lane L3). It
covers `lsp_navigation` `rename` with `apply: true`, which #3736 bound over
four rounds, and `rename_file`'s `workspace/willRenameFiles` edits (#3734).
The `TLA+ models` CI job checks every config here against its `\* expect:`
line (see `formal/file-locks/README.md`).

Code references name symbols, read on master at `cf1b548e5`.

## What the model covers

- **The server's view** of each file the edit writes text to:
  - an **opened** file (the client holds a send record) is the last send.
    Sends and the request share one connection, so the server computes from
    the sends made before the request;
  - an **unopened** file is the copy the server read **at project load**.
    The initial state is the loaded project, so every later write comes
    after the load. This is the #3736 round-3 lesson: tsserver reads
    unopened files at load, not after the request.
- **The `rename` flow** (the `rename` case in `tools/lsp-navigation.ts`):
  1. `Prepare`: `openFileBestEffort` reads the target and sends it.
  2. `Request`: `renameRequestedAtMs` (`T`) is taken just before
     `lspService.rename`, and the server computes from its view.
  3. `Capture`: `captureRenameExpectedContent` binds each file.
  4. `ApplyEdit`: `applyWorkspaceEdit` with that `expectedContent`.
- **The `renameFile` flow** (`LSPService.renameFile` in
  `clients/lsp/index.ts`): `willRenameFiles` (`Request`), the merged text
  edits applied with no `expectedContent` (`applyWorkspaceEdit(merged.edit`),
  then `didClose` and the resource move. Either can fail after the text
  edits (`Abort`; `didClose` throws "workspace/didClose failed; rename
  aborted").
- **The send-change stamp** (`changedAtMs`): `recordSentContent` in
  `clients/lsp/client.ts` moves it only when the bytes change. A first
  `didOpen` has no previous record, so it always stamps. The record also
  keeps `openedAtMs` (`openedAt`), the instant of its first send, and
  `openedHash` (`openedC`), that send's bytes, which a change or a re-send
  keeps and a close drops (#3827). The client also
  reports its own start (`clientStartedAtMs`, stamped when `createLSPClient`
  builds its state, before `initialize`), which the model folds into
  `mtime = 0` ("older than the start by the margin").
- **`SyncBeforeCapture`** (#3827 r2) requires every pending pi sync to land
  before `Capture`. It isolates a sync that lands inside the request window
  (the first open under review) from `Issue3747LateHookSync`'s sync that lands
  after the capture.
- **`ForceFirstOpen`** (#3827 r3) requires every file to be sent before
  `Capture` and lets an external write land only on a file already sent. It
  isolates a write after the first open (verify r2 F4, visible through the
  client's record) from a write before it (F6, #3747's blind spot, which no
  client record can see).
- **Writers:**
  - `PiWrite`: pi's queued writers, meaning the agent's `edit` and `write`,
    and the formatter since #3610. Each write is followed by a `touchFile`
    sync (`PiSync`) that can land late or never: `runPipeline` in
    `clients/pipeline.ts` syncs in its step 4 ("LSP file sync"), after the
    format and fix steps, and `resyncLspFile` never syncs a file that
    `exceedsLspSyncLimits`. By default the sync sends the current disk.
    Under `SyncCarriesRead` it sends the bytes its own pipeline wrote, and a
    stamped sync older than the last stamped one sent is dropped (the #3481
    `readStamp` drop in `enqueueDocumentNotify`, `clients/lsp/client.ts`).
    `openFileBestEffort`'s send carries no `readStamp`, so nothing orders a
    stamped sync against it;
  - `ExternalWrite`: no queue and no sync. With `KeepMtime`, the write may
    keep the file's old mtime (`cp -p`, `utimes`). With `WatcherPrompt`, the
    server's own file watcher delivers it at once for an unopened file;
  - `Touch`: a read auto-touch or a cascade touch sends the disk bytes with
    no write. For an unopened file it is the `didOpen`.
- **`ApplyEdit`**: under `withHostFileMutationQueues` for every touched
  path, `preflightWorkspaceEdit` compares each expected content with the
  disk (`contentFor`, `clients/lsp/edits.ts`) before any write, and refuses
  the whole edit on a mismatch. By default the compare and the write are one
  step. Under `SplitApply` they are two, and an unqueued writer can land
  between them: the write loop in `applyWorkspaceEdit` re-reads each file
  and writes it with no second compare.

### The `LspEdit` writer belongs to lane L5

Lane L5 owns the `LspEdit` writer, in `formal/dispatch-pipeline`. It had not
landed when this family was written, so `ApplyEdit` here stands in for it
with the same contract: compare under the queues, then write, with no queued
writer in between. `MergedSplitApply` shows the gap an unqueued writer can
enter; what the writer does without the queues is L5's to model. When L5
lands, `ApplyEdit` should cite its action by name.

### Capture rules (`Rule`)

| Rule | Target | Opened non-target | Unopened non-target | Code |
|---|---|---|---|---|
| `none` | not bound | not bound | not bound | before #3736; `renameFile` on master |
| `r1` | bytes `Prepare` read | bytes read at capture | bytes read at capture | #3736 round 1 (`1fbc52f4d`) |
| `r2` | same | refuse if disk differs from the last send | refused | round 2 (`92d14c0c6`) |
| `r3` | same | as `r2` | refuse if mtime is at or after `T - Margin` | round 3 (`c64b10a8f`) |
| `merged` | same | as `r2`, and refuse if the send changed at or after `T` | as `r3` | round 4, master (`captureRenameExpectedContent`, `RENAME_MTIME_MARGIN_MS`) |

Under `FirstOpenExempt` (#3827, `merged` only) a file whose record's first
send was at or after `T` is bound by one of three rules:

- `"off"`: by its send record (master before #3827; refuses a benign first
  open, `MergedFirstOpenTouch`).
- `"stamp"`: as unopened, whatever it holds. The first #3827 rule. Review r1
  F1 refuted it: a never-opened file that pi wrote (older than the margin
  before `T`) whose sync lands as the first open inside the request window is
  applied at the server's load-time offsets (`FirstOpenPiWriteStamp`).
- `"quietNoHash"` (r2, f49c6c04c): as unopened only if nothing wrote the
  file since the client started (`mtime[f] = 0`; code: mtime older than
  `clientStartedAtMs` by the margin, `captureRenameExpectedContent`), else by
  its send record. A file nobody wrote holds, on disk, the bytes the server
  could only have read, so the first open adds none. The model stamps every
  write at `clock >= Margin + 1`, after the start, so `mtime = 0` is that test.
  Verify r2 F4 refuted it: the exempt file skipped the whole send check, so a
  write after the first open that kept the old mtime was applied
  (`FirstOpenThenKeepMtimeNoHash`, probe P7).
- `"quietHash"` (the verify-r2 prescription): as `"quietNoHash"`, and refused
  when the disk is not the last send. A resync after that write makes the
  disk equal the last send, so it is still applied
  (`FirstOpenThenKeepMtimeHashOnly`, state table row B11, probe P9).
- `"quiet"` (shipped, r3): as `"quietHash"`, and refused when the send record
  changed after its first send (`sent[f] # openedC[f]`; code: `openedHash`
  differs from `hash`). Only the first send's own stamp is skipped
  (`FirstOpenThenKeepMtime` passes).

Under the three quiet modes a file written since the client started and first opened in
the window keeps master's refusal. That is a false refusal when the server
already got the write (a prompt watcher): the client cannot tell the two
apart, so `Accepted` names it. A retry passes.

## Invariants

- `NoStaleApply`: every file the edit wrote held the bytes the server
  computed the edit from.
- `AtomicRefusal`: a refused or aborted operation wrote nothing.
- `NoUnexplainedRefusal`: a refusal names at least one file, and each file
  it names either held bytes other than the ones the server computed from
  (the edit would have been stale there) or is one of master's accepted
  false refusals (`Accepted`):
  - a changed send stamped in `T`'s own tick (the `>=` tie), also for a quiet
    first-opened file whose record changed after its first send (r3);
  - an unopened file whose mtime is within the margin of `T` (under
    `FirstOpenExempt = "stamp"` or a quiet mode, a file first opened at or
    after `T` counts as unopened when `"stamp"` says so or it is quiet);
  - under a quiet mode, a file written since the client started and first opened
    at or after `T` (master's refusal, kept);
  - the target, which is held to the bytes `openFileBestEffort` read, even
    when a later sync has already given the server the current bytes.

  Without this invariant, a rule that refuses everything would pass, and
  round 2's defect would be invisible.
- `NoAppliedAfterInFlightWrite` is a reachability witness, checked only by
  `MergedWitness`: a rename applies after a write concurrent with it.

## Results

TLC 1.7.4, one worker. The #3827 `openedAt` and `openedC` variables raised
the counts of configs with sends from the #3803 run (counts below are the r3
run). Constants shared by every config:
`Margin = 1`, `MaxWrites = 2`, `MaxClock = 4`; the clock starts at `Margin + 1`, so an
untouched file is older than the margin.

| Config | Verdict | Distinct states |
|---|---|---|
| `Merged` | pass | 53421 |
| `MergedWitness` | `NoAppliedAfterInFlightWrite` violated (non-vacuity) | 19249 |
| `MergedTargetRevert` | `NoStaleApply` violated | 30120 |
| `MergedTargetOlderSync` | `NoStaleApply` violated | 31176 |
| `CandidateStampedPrepare` | pass (`NoStaleApply`, `AtomicRefusal`) | 90111 |
| `MergedSplitApply` | `NoStaleApply` violated | 7635 |
| `PreFix` | `NoStaleApply` violated | 518 |
| `R1CaptureRead` | `NoStaleApply` violated | 199 |
| `R2RefuseUnopened` | `NoUnexplainedRefusal` violated | 122 |
| `R3HashOnly` | `NoStaleApply` violated | 429 |
| `R3MtimeAtLoad` | `NoStaleApply` violated | 274 |
| `Issue3747External` | `NoStaleApply` violated | 274 |
| `Issue3747KeepMtime` | `NoStaleApply` violated | 229 |
| `Issue3747LateHookSync` | `NoStaleApply` violated | 812 |
| `Issue3747PromptWatcher` | pass | 375 |
| `MergedFirstOpenTouch` | `NoUnexplainedRefusal` violated | 80 |
| `FirstOpenExempt` | pass | 134 |
| `FirstOpenExemptOpenedWrites` | pass | 198713 |
| `FirstOpenExemptRewrite` | pass | 3870 |
| `FirstOpenPiWriteStamp` | `NoStaleApply` violated | 3102 |
| `FirstOpenPiWriteQuiet` | pass | 4744 |
| `FirstOpenPiWriteOff` | pass (`NoStaleApply`, `AtomicRefusal`) | 4759 |
| `FirstOpenExternalWatcher` | pass | 6742 |
| `FirstOpenExternalKeepMtime` | `NoStaleApply` violated (#3747's trace; the exemption's own F6 trace is longer) | 852 |
| `FirstOpenExternalKeepMtimeOff` | `NoStaleApply` violated (#3747 baseline) | 857 |
| `FirstOpenExternalNoWatcher` | `NoStaleApply` violated (#3747, not the exemption) | 2822 |
| `FirstOpenThenKeepMtime` | pass | 7818 |
| `FirstOpenThenKeepMtimeNoHash` | `NoStaleApply` violated (verify r2 F4) | 1315 |
| `FirstOpenThenKeepMtimeHashOnly` | `NoStaleApply` violated (row B11) | 2810 |
| `FirstOpenThenKeepMtimeOff` | pass (`NoStaleApply`, `AtomicRefusal`) | 7085 |
| `Issue3734Master` | `NoStaleApply` violated | 76 |
| `Issue3734Bound` | pass | 1875 |
| `Issue3734Abort` | `AtomicRefusal` violated | 149 |

### Provenance

"master" is today's code, "pre-fix" is code before a #3736 round, and
"candidate" is a fix that has not been written. `PiSync` shows as `Next` in
TLC's traces, because it is chosen under `\E p \in pending`.

| Config | Issue | Provenance | Shortest counterexample |
|---|---|---|---|
| `Merged` | #3601, #3736 | master, under the three assumptions below: the target and opened files are bound; pi writes, external writes and touches of the target and an opened file; an unopened file that nobody writes | none (pass) |
| `MergedWitness` | non-vacuity | master, as `Merged` | `Prepare`, a pi write to the opened file and its sync, `Tick`, `Request`, `Capture`, `ApplyEdit` applies. |
| `MergedTargetRevert` | outside `Merged`'s claim (A-B-A) | master, with `Revert` | `Prepare` reads the target, a pi write to it and its sync, `Request` (the server has the new bytes), `Capture`, a write restoring the old bytes, `ApplyEdit`: the target matches what `Prepare` read but not what the server computed from. Checks `NoStaleApply` and `AtomicRefusal` only: A-B-A also gives safe false refusals of opened files. |
| `MergedTargetOlderSync` | outside `Merged`'s claim (older sync) | master, with `SyncCarriesRead` | Two pi writes to the target, `Prepare` reads and sends the second, the first write's stamped sync lands after it (it is the first stamped sync, so nothing drops it), `Request`, `Capture`, `ApplyEdit`. Checks `NoStaleApply` and `AtomicRefusal` only: an older sync of an opened file after the request also gives safe false refusals. |
| `CandidateStampedPrepare` | #3481 drop, candidate | candidate: `openFileBestEffort`'s send carries a `readStamp` (`StampedPrepare`), with `SyncCarriesRead` | none (pass on `NoStaleApply` and `AtomicRefusal`). Without the #3481 drop it is violated. `NoUnexplainedRefusal` is left out: it still reds, on the safe false refusal above. |
| `MergedSplitApply` | outside `Merged`'s claim (lane L5) | master, with `SplitApply` | `Prepare`, `Request`, `Capture`, the apply's compare, an external write to the target, the apply's write. |
| `PreFix` | #3601 | pre-fix: no `expectedContent` before #3736 | `Prepare`, `Request`, `Capture`, a pi write to the target, `ApplyEdit` over it. |
| `R1CaptureRead` | #3736 round-1 review F1 | pre-fix: round 1 (`1fbc52f4d`) binds every file to a read at capture | `Prepare`, `Request`, a pi write to the opened file, `Capture` (binds the new bytes), `ApplyEdit`. |
| `R2RefuseUnopened` | #3736 round-2 decision | pre-fix: round 2 (`92d14c0c6`) refuses every unopened file | `Prepare`, `Request`, `Capture` refuses the quiet unopened file. No write happened. |
| `R3HashOnly` | #3736 verify r3 V1 | pre-fix: round 3 (`c64b10a8f`) checks only that the disk equals the last send | `Prepare`, `Request`, a pi write to the opened file, its sync, `Capture` (disk equals the last send), `ApplyEdit`: the server computed from the send before. |
| `R3MtimeAtLoad` | #3736 verify r3 V2 | pre-fix: round 3's mtime rule, with the server reading at load | `Prepare`, an external write to the unopened file, two ticks, `Request`, `Capture` (mtime older than the margin), `ApplyEdit`. |
| `Issue3747External` | #3747 (open) | master: the same trace under round 4, whose unopened rule is round 3's | As `R3MtimeAtLoad`. |
| `Issue3747KeepMtime` | #3747 (open) | master, with a prompt watcher | `Prepare`, `Request`, an external write that keeps the old mtime, `Capture`, `ApplyEdit`. |
| `Issue3747PromptWatcher` | #3747 boundary | master, with a prompt watcher and honest mtimes | none (pass) |
| `Issue3747LateHookSync` | #3747 (open), model finding | master: pi's own write to an unopened file, its sync still pending | `Prepare`, a pi write to the unopened file, two ticks, `Request` with the sync pending, `Capture` (unopened, mtime older than the margin), `ApplyEdit`. |
| `MergedFirstOpenTouch` | #3827, model finding (safe) | before the #3827 fix (`FirstOpenExempt = FALSE`): a first `didOpen` always stamps (`recordSentContent`) | `Prepare`, `Request`, `Tick`, a touch that first opens the unopened file (same bytes), `Capture` refuses it on the stamp. In `T`'s own tick the refusal is the accepted `>=` tie. |
| `FirstOpenExempt` | #3827 | fix (`"quiet"`): a first send at or after `T` of a file nobody wrote since the client started takes the unopened rule | none (pass). The `MergedFirstOpenTouch` shape no longer refuses. |
| `FirstOpenExemptOpenedWrites` | #3827 | fix, with `Merged`'s writers and a first-open touch of the unopened file | none (pass). The opened-file rule holds as in `Merged`. With `openedAt` refreshed on every send (a model mutation), it violates `NoStaleApply`. |
| `FirstOpenExemptRewrite` | #3827 | fix, over `Issue3747PromptWatcher`: an external write to the unopened file plus first opens of it | none (pass). Its write-then-first-open traces are master's refusal, kept (an `Accepted` false refusal). |
| `FirstOpenPiWriteStamp` | #3827 review r1 F1 | the first #3827 rule (`"stamp"`), with `SyncBeforeCapture` so the sync lands inside the request window | `Prepare`, `PiWrite` to the unopened file, two `Tick`s, `Request`, `PiSync` (the first open), `Capture`, `ApplyEdit`: the mtime rule sees an old mtime and accepts, and the server's load-time copy takes the edit. Probe P1 through the real tool: `let9;` on disk. |
| `FirstOpenPiWriteQuiet` | #3827 r2 | the shipped rule (`"quiet"`), same shape | none (pass). The written file keeps the send stamp, which refuses it. Dropping the `mtime[f] = 0` test (model mutation) gives `FirstOpenPiWriteStamp`'s violation. |
| `FirstOpenPiWriteOff` | #3827 r2 baseline | master before #3827 (`"off"`), same shape | none (pass on `NoStaleApply`, `AtomicRefusal`; `NoUnexplainedRefusal` is left out because master still refuses a benign first open). |
| `FirstOpenExternalWatcher` | #3827 r2 | `"quiet"`, pi and external writers to the first-opened file, honest mtimes, prompt watcher | none (pass) |
| `FirstOpenExternalKeepMtime` | #3747 boundary | `"quiet"`, an external write that keeps the old mtime | As `Issue3747KeepMtime`: the write lands after the request on a file never opened, and the mtime rule is blind. TLC reports this shortest trace; the longer one the exemption adds (the write, then a first open in the window: F6, probe P5, refused on master) is in the same state space. |
| `FirstOpenExternalKeepMtimeOff` | #3747 baseline | `"off"`, same shape | The same shortest trace without the exemption. It shows #3747's own hole, not that the exemption adds none: with the first open forced before the capture, `"off"` passes (`FirstOpenThenKeepMtimeOff`). |
| `FirstOpenExternalNoWatcher` | #3747 boundary | `"quiet"`, external write older than the margin, no watcher | As `Issue3747External`. |
| `FirstOpenThenKeepMtime` | #3827 r3 | the shipped rule (`"quiet"`) with `ForceFirstOpen`: the first-opened file takes pi writes and external writes, keeping the mtime or not, after its first open | none (pass). Refreshing `openedC` on every send (a model mutation) violates `NoStaleApply` with `FirstOpenThenKeepMtimeHashOnly`'s trace; dropping the new `Accepted` tie disjunct violates `NoUnexplainedRefusal` (a change in `T`'s own tick, before the request). |
| `FirstOpenThenKeepMtimeNoHash` | #3827 verify r2 F4 | r2 (`"quietNoHash"`), same shape | `Prepare`, `Request`, `Touch` (the first open, disk bytes), `ExternalWrite` keeping the old mtime, `Capture`, `ApplyEdit`. Probe P7 through the real tool: `let 77;` on disk. |
| `FirstOpenThenKeepMtimeHashOnly` | #3827 r3 row B11 | the verify-r2 prescription (`"quietHash"`), same shape | `Prepare`, `Request`, `Touch`, `ExternalWrite` keeping the old mtime, `Touch` (the resync: disk equals the last send), `Capture`, `ApplyEdit`. Probe P9 through the real tool. |
| `FirstOpenThenKeepMtimeOff` | #3827 r3 baseline | master before #3827 (`"off"`), same shape | none (pass on `NoStaleApply`, `AtomicRefusal`). |
| `Issue3734Master` | #3734 (open) | master: `renameFile` applies with no `expectedContent` | `Request` (`willRenameFiles`), `Capture` (nothing bound), a pi write, `ApplyEdit`. |
| `Issue3734Bound` | #3734 | candidate: the #3736 rule, with `T` taken before `willRenameFiles`, and no `didClose` or move failure (`AbortAfterText = FALSE`) | none (pass) |
| `Issue3734Abort` | #3734, model finding | master order, even with the candidate binding: text edits, then `didClose` and the move | `Request`, `Capture`, `ApplyEdit` writes both files, `Abort`: the rename is reported aborted with the edits written. |

## Findings

1. **The merged behaviour passes within its assumptions** (`Merged`): the
   target and every opened file, with pi writes, external writes,
   mtime-kept writes and identical re-touches. `NoStaleApply` and
   `AtomicRefusal` hold, and every refused file either held bytes other
   than the ones the server computed from or is an accepted false refusal.
2. **Outside those assumptions, the target is exposed.** It is held only to
   the bytes `Prepare` read, not to the client's send record, so two
   behaviours the `Merged` config excludes break it: a write that restores
   earlier bytes (`MergedTargetRevert`) and a late pipeline sync carrying
   older bytes after `openFileBestEffort`'s unstamped send
   (`MergedTargetOlderSync`). Opened non-target files stay safe under both
   (hash plus stamp). Neither trace has been reproduced on a real server.
3. **The atomic apply is load-bearing.** An unqueued write between the
   compare and the write is overwritten (`MergedSplitApply`); lane L5 owns
   that seam.
4. **#3747 is three traces, not two.** The issue names the missed external
   write (`Issue3747External`) and the mtime-kept write
   (`Issue3747KeepMtime`). The model adds pi's own write to an unopened
   file whose `touchFile` sync has not run by the capture
   (`Issue3747LateHookSync`). #3736's state table assumed that sync precedes
   the request. The pipeline syncs after its format and fix steps and never
   syncs a file over the size limit, so a rename in a parallel tool call can
   compute from the load copy while the mtime is older than the margin.
   This trace comes from the model and a code reading; it has not been
   reproduced on a real server.
5. **#3747's boundary:** with a watcher that delivers at once and honest
   mtimes, the mtime rule holds (`Issue3747PromptWatcher`). That is
   consistent with #3736 round 4's probes applying correctly on one machine
   while verify r3 corrupted `b.ts` on another. The model's watcher is
   idealised, so it does not show the cause.
6. **A false refusal on master (safe), #3827, fixed in two rounds.** A read
   or cascade touch that first opens an unopened file after `T` stamped it (a
   first `didOpen` has no previous record), so the rename was refused with "it
   changed after the language server computed the rename from it", although
   no byte changed (`MergedFirstOpenTouch`). Round 1 treated every such file
   as unopened (`"stamp"`). That was wrong: master's stamp also refused the
   dangerous case, a never-opened file that pi had written, whose pipeline
   sync lands as the first open inside the request window and delivers bytes
   the server never saw. The unopened mtime rule accepts it because the mtime
   is old, so the rename applied at the load-time copy's offsets
   (`FirstOpenPiWriteStamp`, probe P1). The shipped rule (`"quiet"`) exempts
   a first open only when the file's mtime is older than the client's start
   by the margin: then nothing wrote it since the server could have read it.
   The exemption is then no weaker than master for a file written with an
   honest mtime. Round 2's rule skipped the whole send check, so a write after
   the first open that kept the old mtime was applied where master refused it
   (verify r2 F4, `FirstOpenThenKeepMtimeNoHash`); round 3 keeps the hash
   check and refuses a record whose bytes changed after its first send
   (`FirstOpenThenKeepMtime`; the hash check alone leaves the resync case,
   `FirstOpenThenKeepMtimeHashOnly`). A write that keeps the old mtime
   BEFORE the first open is still applied, and master refused it (F6, probe
   P5): the first open carries the new bytes and the mtime is old, so no
   client record shows it. That is #3747's blind spot made reachable by the
   exemption, not the same violation as with the exemption off;
   `FirstOpenExternalKeepMtime` and `FirstOpenExternalNoWatcher` report
   #3747's shorter traces, which `"off"` shares.
7. **#3734:** binding the `willRenameFiles` edits with the #3736 rule closes
   the stale apply for opened files only when nothing fails after the text
   edits (`Issue3734Bound` sets `AbortAfterText = FALSE`; unopened files
   then inherit #3747). Binding alone does not make `rename_file` atomic:
   `renameFile` writes the text edits before `didClose` and the resource
   move, and a failure in either aborts with the importers already
   rewritten (`Issue3734Abort`). Moving the file first is not atomic
   either, if the text edits can then be refused (the file stays moved).
   That ordering is argued, not modelled.

## Assumptions and scope

- **The `Merged` claim rests on three assumptions**, each dropped by a
  config that then violates `NoStaleApply`:
  - every write produces bytes the file never held (`Revert = FALSE`;
    dropped by `MergedTargetRevert`);
  - a pi sync sends the current disk (`SyncCarriesRead = FALSE`; dropped by
    `MergedTargetOlderSync`; `CandidateStampedPrepare` shows that stamping
    `openFileBestEffort`'s send makes the #3481 drop close it);
  - the apply is atomic against unqueued writers (`SplitApply = FALSE`;
    dropped by `MergedSplitApply`).
- **Close is not modelled** (#3827 review r1 F2, F3). `closeDocument` drops
  the client's record, so a close between compute and apply followed by a
  reopen counts as a first open, and a close with no reopen leaves a bound
  file with no record. The probes (review r1: P2 close and reopen applied on
  the head, refused on master; P3 bare close applied on both; a model copy
  with a `Close` action violated `NoStaleApply` with the exemption off and
  on) show the bare-close hole is master's and the reopen interleaving is the
  exemption's extension of it. In production only `LSPService.renameFile` (on
  the file it then moves) and client teardown or replacement close a tracked
  document, so the incidence is very low. Tracked on #3747 (the unopened
  rule's blind spots), not modelled here. A replacement client has a fresh
  start stamp and a fresh record, so the guard's `mtime` test applies to it
  as to a first client.
- **The empty target is not modelled.** `openFileBestEffort` returns `""`
  for an empty file before it reaches `touchFile`, so the target is bound
  to `""` while the server was never sent it. `Prepare` always sends. A
  `Prepare` without the send reds `Merged` (`NoStaleApply`), so the model
  would see this branch if it were added.
- **The server's own watching of unopened files is not modelled** (except
  `WatcherPrompt`'s instant delivery). Watching only moves the server's
  copy toward the disk. `Capture` and `ApplyEdit` never read the server's
  view, so a watch delivery cannot turn a correct apply into a stale one;
  leaving it out keeps every stale trace and drops none.
- **`Capture` is one step.** Each file's check reads only that file, and
  the apply compares every bound file again, so interleaving writes between
  the per-file reads adds no behaviour.
- **The margin** only adds refusals, so it cannot hide a stale apply. It is
  modelled to place `Issue3747LateHookSync` past it and to state the
  accepted false refusals exactly.
- **One edit covers every file in `Files`.** The server's per-file choice
  of which files to touch is not modelled.
- Not modelled: #3736's residuals (b) (a swallowed target `touchFile`), (c)
  (two clients tracking one file), (d) (a backward clock step) and (e)
  (symlink spellings); the post-apply resync; diagnostics. The model has one
  client with a fixed start, so the quiet test is judged on the start of the
  client that holds the record: a client replaced inside the window, or a
  second client that alone holds the file, is outside it (#3827 verify r2 F5,
  probes R2 and P1c, tracked on #3747).
