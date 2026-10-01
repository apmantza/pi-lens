# Dispatch pipeline model

A TLA+ model of one file on the post-write dispatch path. The agent edits
the file. Each edit's `tool_result` handler starts a pipeline run. The runs
write per-file stores, and pi-lens' own in-place autofix and LSP workspace
edits write the file. A second module, `SiblingRestore.tla`, models the
sibling file of a whole-package fixer and its restore. The
`TLA+ models` CI job (`node scripts/check-tla-models.mjs`) checks every
config here against its `\* expect:` line.

Issues: #3506, #3507, #3508, #3541, #3598, #3741; model lane L5 of #3803.

## What the model covers

- **The agent.** It makes edits 1..N of file F, in order. Each edit is a
  read-modify-write under pi's per-file `withFileMutationQueue`
  (pi-coding-agent `core/tools/edit.js`). With `Parallel`, which is pi's
  default `toolExecution` (`agent-loop.js` `executeToolCallsParallel`), edit
  i+1 can execute while edit i's handler is still running. Without it, pi
  awaits the handler (`afterToolCall`), unless the handler's 10 s bound
  abandons it (`Orphan`: `index.ts` ~2723 `bounded(handleToolResult(...))`;
  `bounded` does not cancel the work).
- **Handler and pipeline i** (`runtime-tool-result.ts`, `pipeline.ts`). Each
  step boundary is an await:
  1. `Hash`: `postWriteStateHash` (~2365), `claimPipelineDispatch` (~449:
     in-flight dedupe on (file, hash), then the already-analysed latch), and
     `nextWriteIndex` (~2529). When the clients are resident, the same
     synchronous block also covers `registerInFlightPipeline` (~950),
     `admitWidgetDiagnosticsWrite` (pipeline.ts ~1688) and the content read
     (~1711).
  2. `Gap` (`ClaimGap`): `await bounded(classifiedClients)` (~2462), which sits
     between the claim and the registration when the clients are not
     resident.
  3. `FixRead` / `FixWrite`: the in-place fixer (`runAutofix`, for example
     `biome lint --write`) reads F and later writes its fix of what it read.
     Only a turn's first `write` runs this (`recordMutationToolReceipt`: edits
     are deferred).
     With `WriterBound`, the writer's own bound (FormatService's per-file
     budget, `format-service.ts` `runFormattersWithConcurrency`) can give up
     on it (`WriterAbandon`) while its in-place child runs on; the child
     writes its fix of what it read later (`OrphanWrite`), after the
     pipeline has carried on.
  4. `Refresh`: the before/after compare (biome-client.ts ~410), the content
     refresh, and the `postWriteStateHash` capture (pipeline.ts ~1843-1880).
  5. `Analyse`: `dispatchLintWithResult` returns, and `recordDiagnostics`
     writes the widget store under its `WriteOrderingGuard`.
  6. `Release`: `releaseInFlightPipeline` (deletes by hash key), and the
     already-analysed latch is set.
  7. `Record`: the handler's `recordInlineBlockers` / `clearInlineBlockers`
     (~2888 / ~2909). This is the turn-end "Unresolved from this turn" record,
     and the git-guard latch aggregates it (`runtime-coordinator.ts` ~653).

- **The LSP workspace edit** (`LspRead` / `LspWrite`, `lsp/edits.ts`
  `applyWorkspaceEdit` ~1430). After the server answers, `applyWorkspaceEdit`
  takes pi's per-file queue for every path it writes
  (`withHostFileMutationQueues`, ~1475, #3541), and the preflight read and
  the write of each text operation both run inside it. Edit k adds the id
  `Edits + k` to the content, so `NoLostEdit` covers it like an agent edit.
  `LspQueue = FALSE` is the code before #3541, or a host with no queue (the
  MCP adapter: it has no pi agent edit to race). This lane owns the writer.
  `formal/lsp-rename-edit` (#3826) models the multi-file compare-then-write
  `ApplyEdit` as the atomic composite of `LspRead` + `LspWrite`; it cites them
  by name and nothing mechanical ties the names, so a rename here is mirrored
  there. An LSP edit starts no pipeline handler in this model, so
  `WidgetNewest`, `WidgetExact`, `InlineNewest` and `InlineExact` are not
  claimed for `LspEdits > 0`: the configs that set it check `NoLostEdit`,
  `NoForeignAttribution` and `NoDoubleDispatch`. Not modelled here: whether the server computed the edit from the bytes now on disk
  (`expectedContent`, #3601; that is the rename family's question), and the
  pipeline the edit's bridged mutation starts.

A content value is the set of agent edits it contains plus a "fixed" bit, so
a fixer that writes back stale bytes shows up as a missing edit. Whether a
content has a blocker depends on the newest edit it contains; the assignment
is chosen at Init, so every assignment is checked.

## Invariants

| Invariant | Promise | Source |
|---|---|---|
| `InlineNewest` / `InlineExact` | at quiescence the inline-blocker record (and the git guard built from it) is the verdict on the newest revision | "a slow old clean ... must not erase" a newer blocker: `runtime-coordinator.ts` ~198-203, ~1636-1641 (#1198 invariants 1-2) |
| `WidgetNewest` / `WidgetExact` | the widget store ends on the newest revision (`Exact`: on the exact bytes, pi-lens' fix included) | `widget-state.ts` ~309-317 |
| `NoLostEdit` | no pi-lens writer (the autofix, an LSP workspace edit) overwrites an agent edit or another writer's edit | pi `docs/extensions.md` ~135: a file-mutating tool must wrap its read-modify-write in `withFileMutationQueue` |
| `NoForeignAttribution` | what the pipeline reports as its own autofix write contains no agent edit that the fixer did not read | `pipeline.ts` ~1861-1880 (`fileModified`, `postWriteStateHash`, the "authoritative" attachment) |
| `NoDoubleDispatch` | no two pipelines analyse one (file, state) concurrently | `runtime-tool-result.ts` ~420-448, ~2452-2459 ("Nothing may await between this claim and the dispatch") |

## Results

TLC 2.19 (`tla2tools.jar` v1.7.4), `-workers auto`. The configs named after
a bug now model the fixed code; each part of each fix keeps a violated
witness, so a change that drops it turns the check red.

| Config | Models | Expect | Distinct states |
|---|---|---|---|
| `InlineSequential` | before #3507, sequential tools | pass | 152 |
| `InlineParallel` | fixed code (#3507) | pass | 256 |
| `InlineFix` | fixed code (#3507), three edits | pass | 8,176 |
| `InlineFixNoRecord` / `NoClear` / `NoTomb` | #3507 without one part | violated `InlineNewest` | ~260 each |
| `WidgetParallel` | the widget guard, with the pre-#3508 claim gap | pass | 732,720 |
| `MutWidgetNoGuard` | the widget without its guard | violated `WidgetNewest` | 819 |
| `FixerSequential` | before #3506, sequential tools | pass | 176 |
| `FixerParallel` | fixed code (#3506 with review round 1), writer bound | pass | 1,564 |
| `FixerOrphan` | fixed code (#3506 with review round 1), handler abandoned, writer bound | pass | 3,080 |
| `FixerAttribution` | fixed code (#3506) | pass | 840 |
| `FixerQueue` | fixed code (#3506), three edits | pass | 829,712 |
| `MutFixerNoQueue` | #3506 without part 1 (the code before it) | violated `NoLostEdit` | 156 |
| `FixerQueueWriteOnly` | #3506 without part 2 | violated `NoForeignAttribution` | 218 |
| `FixerQueueNoReToken` | #3506 without part 3 | violated `WidgetNewest` | 24,746 |
| `MutWriterNoHold` | the round-1 code: the hold released while an abandoned writer's child runs | violated `NoLostEdit` | 457 (at the violation) |
| `ClaimAtomic` | resident clients | pass | 797,392 |
| `ClaimGap` | fixed code (#3508) | pass | 264 |
| `MutClaimGap` | the code before #3508 | violated `NoDoubleDispatch` | 57 |
| `MutNoInflightDedupe` | the claim without the in-flight dedupe | violated `NoDoubleDispatch` | 68 |
| `AllActorsFix` | all three fixes | pass | 43,512 |
| `AllActorsFixOrphan` | all three fixes, handler abandoned | pass | 804,400 |
| `LspEditQueue` | merged LSP edit writer (#3541) beside two agent edits, two queued autofixes, abandoned handlers and writers | pass | 510,352 |
| `MutLspEditNoQueue` | the LSP edit writer without pi's queue (the code before #3541, or a host with no queue) | violated `NoLostEdit` | 67 (at the violation) |
| `MutFixerNoQueueLsp` | one agent edit and an LSP edit, the autofix outside pi's queue (#3506 part 1 removed): its stale write erases the LSP edit, the only edit it can | violated `NoLostEdit` | 51 (at the violation) |

Non-vacuity:
- The widget's existing guard is load-bearing: `MutWidgetNoGuard` goes red.
- The in-flight dedupe is load-bearing: `MutNoInflightDedupe` goes red.
- pi's own serialisation of the handler is what kept `InlineSequential` and
  `FixerSequential` green before the fixes. `InlineParallel`, `FixerParallel`
  and `FixerOrphan` remove it.

## Bugs (all five reproduced on the real code, all fixed)

1. **The inline-blocker record was last-completer-wins** (#3507). The handler
   recorded or cleared the record with no order check. The record stored
   `writeIndex` but never compared it. An older clean run that settled last
   erased the newer edit's blocker, and the git guard unlatched. An older
   blocker that settled last replaced the newer verdict with a
   `writeIndex: 1` record. The widget store, which has the guard, kept v2 in
   both cases.
2. **The immediate autofix ran outside pi's mutation queue** (#3506). Take a
   turn's first `write` followed by an edit of the same file, either in one
   parallel batch or after the write's pipeline outlived its 10 s bound. The
   fixer's stale write erased the agent's edit, and the tool result called
   the erased content "authoritative". An agent edit inside the fixer's
   before/after window was instead claimed as pi-lens' autofix. Its hash then
   became the already-analysed latch, and the edit's own tool result was
   empty.
3. **The claim was not atomic when the clients were not resident** (#3508).
   The classified path awaited the bootstrap clients after
   `claimPipelineDispatch`, so two handlers for one post-write state both ran
   the pipeline.
4. **A refreshed pipeline kept the handler's `writeIndex`** (#3506 part 3).
   Once the fixer queues behind agent edits, a pipeline whose autofix ran on
   a newer revision analyses those bytes; under the older token the ordering
   guard kept an older verdict, while the newest edit's own run was skipped
   by the latch. For the latch to skip it, that edit's handler must hash the
   file after the older pipeline has finished, so this needs a delayed
   handler.
5. **The hold was released while an abandoned writer ran on** (#3506 review
   round 1). The `--immediate-format` writer's own 10 s budget gave up on a
   formatter whose child (15 s spawn timeout) kept running; the pipeline
   released the hold, pi's next edit landed, and the child wrote its format
   of the pre-edit bytes over it. `MutWriterNoHold` is that code.

## Fixes (checked here, replayed in `tests/clients/dispatch-pipeline-formal.test.ts`)

- **Inline record (#3507).** Record and clear go through one per-path
  `WriteOrderingGuard` on the dispatch's token: compare on record, compare on
  clear, and keep the token across a clear. Dropping any of the three parts
  turns it red. The code orders by `(turnIndex, writeIndex)`: the model has
  one turn, and the code's `writeIndex` restarts at every `beginTurn`, so the
  turn leads the order.
- **Autofix (#3506).** The fixer runs inside pi's `withFileMutationQueue(F)`
  (part 1), and the queue is held through the after-read, the content
  refresh and the `postWriteStateHash` capture (part 2). When the analysed
  bytes are not the ones the pipeline first read, it takes a fresh
  `writeIndex` while it still holds the queue (part 3). Without part 2,
  `FixerQueueWriteOnly` goes red; without part 3, `FixerQueueNoReToken` goes
  red. The code takes the hold at the first format or autofix write, and
  each fixer branch enters it only once its tool is resolved (review round
  1), so neither a pipeline with no writer nor an availability probe or
  install ever holds pi's edits back.
- **Abandoned writer (#3506 review round 1).** `FormatService` reports the
  formatter runs a bound gave up on, and the hold releases only once they
  settle (`FixHoldWriter`). The deferred drain's formatter uses the same
  hold, and its release follows the format phase, not the hook's bound.
- **Claim (#3508).** The clients are awaited before `claimPipelineDispatch`,
  as the observed path already did. This is `ClaimGap = FALSE`.

## LSP workspace edits and the sibling restore (#3803, lane L5)

**LSP edit writer.** `LspEditQueue` passes with the writer inside the queue,
beside the fixer's hold (`FixQueue`, `FixQueueRefresh`, `FixHoldWriter`) and an
abandoned writer. `MutLspEditNoQueue` is the same configuration with
`LspQueue = FALSE`. It turns `NoLostEdit` red. The same configuration with
`LspEdits = 0` passes (17,824 distinct states, run once by hand, not a
committed config), so the writer is what turns it red.

**Sibling restore** (`SiblingRestore.tla`, `clients/fix-run-restore.ts`,
#3598, #3741). One sibling file S of a whole-package fixer (`cargo clippy
--fix`, `dart fix --apply`). The tool reads and writes S outside pi's queue.
The agent edits S under S's queue. pi-lens sees each edit twice: `SACall`
(`noteAgentCallStart`, "in flight") and `SANote` (`noteAgentCallEnd`, then
`noteAgentMutation`, which keeps S's bytes as the capture, checked against
the edit's own stated text). `Finish` is `finish()`: the run leaves `active`,
and `settle` copies the in-flight set. `RRead`, `RRecheck` and `RWrite` are
`settle`'s stat and read with its decision table, its re-stat, and
`writeFileAtomicAsync`; compare and write are two steps because pi's queue for
S is not held.

| Invariant | Promise |
|---|---|
| `NoSilentLoss` | at the end every agent edit of S is on disk, or the report names the file as lost or possibly lost (`NoLostEdit`'s analogue: the eraser is the tool) |
| `EveryEditSurvives` | stronger: at the end every agent edit of S is on disk |
| `NoRestoreOverNewer` | the restore never writes over an agent edit newer than its capture; it is the union of the three below |
| `NoRestoreOverReadEdit` | ... already on disk when the restore read S but not in the capture |
| `NoRestoreOverPreCheckEdit` | ... that landed between the restore's read and its re-stat |
| `NoRestoreOverGapEdit` | ... that landed after the re-stat |
| `NoNoopRestore` | the restore writes nothing when S already holds the capture's bytes (`fix-run-restore.ts` `if (unchanged) continue`) |

Constants: `SConcurrent` (an agent edit of S can run while the run is open: pi's
parallel tools, or a handler abandoned at 10 s while the tool's own timeout is
30 s), `SAtomic` (no agent edit straddles a tool or restore step; `FALSE` lets
one), `SCallInRun` (every agent `tool_call` of S reaches pi-lens while the run
is open; `FALSE` lets one come before `beginFixRun`), `SRestore` (`FALSE`: the
code before #3598), `RestoreInFlight` (settle leaves a file with a call in
flight alone) and `RestoreRecheck` (the re-stat; both #3741 round 2), and two
candidate fixes that are not in the code:
`SettleCapture` (the run stays registered through the restore) and
`RestoreQueue` (the re-stat and the write run inside pi's queue for S);
`RestoreNoCapInFlight` is a third candidate, for finding B (a file with no
capture and a call in flight is named possibly lost), there so the
`overwritten` verdict can be observed. The model has no hold on the target, so
none of the candidates is checked for lock order: `settle` runs inside the
target's hold (`clients/pipeline.ts` `tryRustClippyFix`, `tryDartFix`), and a
queue entry for S taken there is the lock-order break option 1 was rejected
for (#3830).

| Config | Models | Expect | Distinct states |
|---|---|---|---|
| `SiblingSequential` | pi's sequential tools; **vacuous for the restore**: no capture is taken, nothing is restored, reported or in flight, and it means something only beside the concurrent configs (`SConcurrent`) | pass | 72 |
| `SiblingRestoreOneEdit` | merged restore, one concurrent edit (`EveryEditSurvives` too) | pass | 62 |
| `MutSiblingNoRestore` | the code before #3598 | violated `NoSilentLoss` | 34 (at the violation) |
| `SiblingRestoreRecheck` | merged restore, two edits: the re-stat holds its claim | pass | 278 |
| `MutSiblingNoRecheck` | #3741 round 1, before the re-stat | violated `NoRestoreOverPreCheckEdit` | 272 (at the violation) |
| `SiblingRestoreMerged` | **defect 2** on the merged restore: an edit lands between the re-stat and the write | violated `NoRestoreOverGapEdit` | 271 (at the violation) |
| `SiblingRestoreGap` | defect 2 alone: with `SettleCapture` the other windows below are closed, and this one is left | violated `NoRestoreOverNewer` | 246 (at the violation) |
| `SiblingRestoreQueued` | defect 2's fix shape: `SettleCapture` and `RestoreQueue` (also checks `NoNoopRestore`); lock order not checked | pass | 252 |
| `SiblingRestoreLostVerdict` | the `overwritten` verdict, observed with finding B closed by `RestoreNoCapInFlight` | pass | 82 |
| `SiblingRestoreInFlightHeld` | the in-flight check, with the other windows closed and every call reaching pi-lens during the run | pass | 581 |
| `MutSiblingNoInFlight` | the same without the in-flight check (the restore before #3741 round 2) | violated `NoRestoreOverNewer` | 523 (at the violation) |
| `SiblingRestoreDeregistered` | finding A | violated `NoRestoreOverReadEdit` | 252 (at the violation) |
| `SiblingRestoreInFlight` | finding B | violated `NoSilentLoss` | 129 (at the violation) |
| `SiblingRestoreQueuedSilent` | finding C, left after defect 2's fix shape | violated `NoSilentLoss` | 225 (at the violation) |
| `SiblingRestoreCallBeforeRun` | finding D: `SiblingRestoreInFlightHeld` with `SCallInRun = FALSE` | violated `NoRestoreOverNewer` | 1,327 (at the violation) |

Non-vacuity: the restore is load-bearing (`MutSiblingNoRestore` against
`SiblingRestoreOneEdit`); the re-stat is load-bearing (`MutSiblingNoRecheck`
against `SiblingRestoreRecheck`); `SiblingSequential` is the same
configuration as a concurrent one, so `SConcurrent` is what opens the windows
(on its own it exercises no restore path);
the queue is what closes the gap (`SiblingRestoreGap` against
`SiblingRestoreQueued`, which differ only in `RestoreQueue`); the in-flight
check is load-bearing (`MutSiblingNoInFlight` against
`SiblingRestoreInFlightHeld`, which differ only in `RestoreInFlight`); the
equal-bytes skip is observed by `NoNoopRestore` in `SiblingRestoreQueued`
(dropping the skip turns it red); the `overwritten` verdict's report is
observed by `SiblingRestoreLostVerdict` (dropping the `lost` report turns
`NoSilentLoss` red, and so does turning `RestoreNoCapInFlight` off).
One survivor: the verdict's routing (`continue` after reporting `lost`) is
reached only in `SiblingRestoreCallBeforeRun`, which is red for finding D
either way.

**Defect 2 (the stated residual, #3741).** `fix-run-restore.ts`'s "Residual,
stated": the restore is compare-then-write outside pi's queue. The window is an
agent edit of S landing between the re-stat and `writeFileAtomicAsync`. The
trace, from `SiblingRestoreMerged`: edit 1 is captured; the tool writes S
from older bytes; `Finish`, `RRead`, `RRecheck`; edit 2 lands; `RWrite` puts
edit 1's capture over it. The report says `restored`, so nothing names the
lost edit 2. Tracked in #3830 (p2). The fix shape the model accepts is
`SiblingRestoreQueued`: a queue entry for S around the re-stat and the write
only. The model has no hold on the target, so it does not show that shape is
lock-order safe: `settle` runs inside the target's hold, and a queue entry for
S taken there can wait behind a multi-path LSP edit that holds S and waits for
the target (#3830 states the lock order).

**Findings the model showed on the merged code (not in the header).** Four,
each reproduced against the real `beginFixRun` / `noteAgentMutation` /
`finish` with a scratch probe (see the PR body for its output).

- **A, `SiblingRestoreDeregistered`.** `finish()` runs `active.delete(run)`
  before `settle` reads any file, so an agent edit whose `tool_call` comes
  after that is neither in flight nor captured, and `noteAgentMutation` is a
  no-op for it. The restore reads the file, finds it differs from the older
  capture, re-stats it unchanged, and writes the capture over the edit. The
  window runs from `finish()` to that file's read, which grows with the
  number of captured files settled before it; the header's "one syscall gap"
  understates it.
- **B, `SiblingRestoreInFlight`.** `settle` skips a file with no capture
  (`if (!capture) continue`) before it looks at the in-flight set. An agent
  edit whose `tool_result` has not arrived when the tool exits has no capture.
  If the tool's write erased it, the file is neither restored nor reported
  (`agentEdited` lists only captured files).
- **C, `SiblingRestoreQueuedSilent`.** A later capture replaces an earlier
  one. If the tool's stale write erased edit 1 after it was captured, and
  edit 2 then landed on the tool's bytes, edit 2's capture passes its own
  check and edit 1 is in neither the capture nor the report.
- **D, `SiblingRestoreCallBeforeRun`.** `noteAgentCallStart` reaches only an
  active run, so a `tool_call` that passed pi-lens before `beginFixRun` is not
  in flight. Its edit lands during the run with its `tool_result` still to
  come, and the restore writes the older capture over it. Reach: pi's parallel
  batch runs `tool_call` for every call first, so a same-batch sibling is
  always called before `beginFixRun`; but it usually finishes in milliseconds,
  long before the write's pipeline starts the tool, so landing inside the run
  takes a long holder of S's queue. Reachable in the model, narrow in practice.
  The realistic overlap is the abandoned handler, whose next-turn `tool_call`
  arrives during the run and is noted in flight; that path meets defect 2 and
  findings A to C, not D.

## Scope and assumptions

Not modelled:
- several files;
- the cascade;
- the LSP touch/notify queue: it is the `Analyse` await, and
  `formal/lsp-server-content` covers it;
- turn and session boundaries (`sessionGeneration`, the latch's
  `turnIndex`);
- the debounce: its default is 0;
- the deferred `agent_end` format/autofix drain (the code runs it inside the
  same queue; the tests replay it);
- collect-later runners: they share `formal/late-aux-drain`'s freshness-gate
  shape;
- the dispatcher's delta baseline;
- external writers other than pi's edit tools (for the sibling restore: bash,
  bridged and LSP-edit writers of S, whose captures are unverifiable and which
  are never in flight; an agent deleting or renaming S; two captured files);
- whether an LSP edit's positions were computed from the bytes now on disk.

Assumptions:
- A fixer writes a fix of the bytes it read.
- A blocker verdict is a function of the newest agent edit in the content.
- Handlers of one batch run in the order their edits executed.
- Sibling restore: identity is a perfect version counter. The code's identity
  is mtime + size + inode (`clients/fix-run-restore.ts` `sameIdentity`), and an
  in-place agent edit keeps the inode, so the re-stat cannot see a same-size
  edit that lands within one mtime tick; the model does not show that.
