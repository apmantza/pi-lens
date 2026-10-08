# Format drain model

A TLA+ model of one file F and the deferred format drain that pi-lens runs at
`agent_settled` (`runtime-agent-end.ts` `handleAgentEnd`). It runs against
the next agent run, a session replacement (`/new`, fork, resume), and another
pi-lens process. Every config here states its expected verdict on its first
line (see `formal/file-locks/README.md`). The `TLA+ models` CI job
(`node scripts/check-tla-models.mjs`) checks them all.

Issues: #3527 (the drain outside pi's mutation queue), #3528 (the drain
writes the next session's state), #3529 (the drain's LSP sync), #3576 (the
retire without a session bump, and the held resync R1), #3558 and #3610 (the
formatter enters pi's queue after its command resolution), #3599 and #3728
(the bounded post-exit wait), #3828 (the late resync after that bound gave up),
#3858 (the same late resync for the in-band `--immediate-format` caller).

## What the model covers

- **The agent.** It reads F and edits it. A read sends its read-warm touch:
  a stamped LSP sync of the bytes it read (`runtime-tool-call.ts`, the read-warm touch), outside
  pi's queue, which opens F again in a service `/new` retired (#3576 R1). Each
  edit is a read-modify-write under pi's per-file `withFileMutationQueue`.
  After the write it records its own write in the read guard, queues a
  deferred format, and sends a stamped LSP sync of the bytes it read (#3481).
- **pi.** It clears `_isAgentRunActive` before it awaits the `agent_settled`
  handlers. The interactive main loop awaits the prompt, so the next run
  waits for the drain. An RPC prompt (`void session.prompt`) or a host that
  polls `isStreaming` does not wait (`Overlap`). `/new` runs from the editor
  callback while the drain runs, and the drain has no abort signal then.
- **The drain.** It captures the session generation and claims the record
  (`handleAgentEnd`). The format phase (`pipeline.ts`
  `runFormatPhase`, `formatters.ts` `formatFile`) then:
  1. resolves the formatter's command (`resolveCommand`; an auto-install runs
     here, outside pi's queue: `DStart`, `SubResolved`);
  2. enters pi's queue (`SubEnter`, #3610) and reads `contentBefore`;
  3. spawns an in-place formatter child, which reads F and writes its format
     of what it read;
  4. reads `contentAfter`, then `fileContent` with its stamp.

  The apply loop then records the format (change log, `recordWritten`,
  modified range, turn summary) and resyncs the LSP.

  - The hook bound is `bounded(…, 10 s)`. When it gives up, the handler
    requeues the record and moves on, while the formatter run goes on, in any
    of its steps, and writes later (`Orphan`, `Abandon`).
  - With `FixQueue`, #3561's format hold covers steps 2-4; it is released
    when the phase settles. `EnterAfterResolve` (#3610) puts its entry after
    step 1.
  - With `FixQueueHold`, an abandoned child keeps the hold until it has
    written.
  - The post-exit resync waits for the abandoned run under
    `DEFERRED_FORMAT_BUDGET_MS`. With `OrphanSyncBound` (#3728) the wait gives
    up while the run is alive (`OrphanGiveUp`); `OrphanLateSync` (#3828) then
    chains the resync onto the run's settlement (`gaveUp` in `SubWrite`).
  - With `InBand` (#3858) the caller is the tool_result pipeline
    (`analysePipeline`, `--immediate-format`), which waits for nothing after the
    bound: `Abandon` reports no format, requeues nothing and sets `gaveUp`, and
    the pipeline goes on to its tail, `DFc` and `DApply` (the `fileContent` read
    and the LSP send of the bytes from before the run's write), while the run is
    alive and keeps its own queue entry. The run's late write is then synced
    only with `OrphanLateSync`: the same chain at its second call site.
- **`/new`** (or fork, resume) resets the session state and retires the
  LSP service (`resetLSPService`). The next touch opens a fresh document, so
  a drain touch after the reset would spawn a server for the next session
  (review round 1, F1). The model closes the LSP document at `NewSession`.
- **A retire without a session bump** (`IdleRetire`, #3576): `session_shutdown`
  and the idle reset call `resetLSPService` but not `resetForSession`
  (`Retire`). Both bump the LSP service generation (`lsp-launch-availability`,
  `clients/lsp/server.ts`), as `NewSession` does.
- **Another pi-lens process** can format F. Its formatter runs outside this
  process's queue (`ExtWrites`).

A content value is the set of agent edits it contains plus a "formatted"
bit. So a formatter that writes back stale bytes shows up as a missing edit.

## Fix parts

| Constant | Code |
|---|---|
| `FixQueue` | #3561: `holdFileMutationQueue` in the drain's format worker (`handleAgentEnd`); the run enters it (`FormatService.formatFile`, `writeHold`) before `contentBefore` |
| `FixQueueHold` | #3561: the hold's release follows the phase, not the bound (`handleAgentEnd`), and waits for `FormatSummary.abandoned` |
| `FixGen` | #3528: `captureSessionGeneration` before the claim; the requeue, autofix and format bookkeeping go through `guardedWrite` |
| `FixStamp` | #3529: the apply loop passes `result.fileReadStamp` to `resyncLspFile`; the post-exit send carries its own read's stamp |
| `EnterAfterResolve` | #3610 (#3558): `formatFile` calls `enter` after `resolveCommand`, so an install holds no queue entry; without it the hold is taken before the resolution |
| `FixOrphanSync` | #3529: once an abandoned phase and its abandoned formatters have settled, a fresh stamped read of F is resynced (`handleAgentEnd`, the post-exit resync). The read and the send are separate steps, as in the code |
| `OrphanSyncBound` | not a fix: #3599/#3728 bound that wait by `DEFERRED_FORMAT_BUDGET_MS`, so it can give up while the run is alive |
| `OrphanLateSync` | #3828, #3858: a give-up chains a resync onto the abandoned run's settlement (`chainLateFormatResync`, called by `handleAgentEnd` as `deferred_format_late_resync` and by `analysePipeline` as `inband_format_late_resync`); it needs `FixOrphanSync`. In the code it is held-only in every case (`resyncHeldLspDocument`, #3828 r2): the model has no action that closes a document, so a current-session send to a held F and a held-only one are the same step here, and the no-spawn half is pinned by the replays, not by TLC |
| `InBand` | #3858: not a fix: the run's caller is the in-band pipeline, so the bound's expiry leaves the pipeline's tail running (`Abandon`, `DFc`, `DApply`) instead of requeuing and ending the caller's work |
| `LspGen` | #3528 r1 F1: the drain's LSP sends (the in-hook format and autofix resyncs and the post-exit resync) run only while its session is current |
| `StartGen` | #3528 r1 F1: after `/new`, the format worker and the autofix loop start no new file; that write's sync would be skipped |
| `ServiceGen` | #3576: the drain's LSP sends also check the LSP service generation it captured (`captureLspServiceGeneration`), so a retire without a session bump stops them too |
| `HeldResync` | #3576 R1: a drain send whose session or service was replaced goes only to a document a live client already holds, from a fresh read of F (`resyncHeldLspDocument`: `peekLSPService` and `resyncGitChangedFiles`); it never opens one |
| `GenDropsAll` | mutant only: the session guard drops every write and every drain send |

## Invariants

| Invariant | Promise |
|---|---|
| `NoLostEdit` | the drain never overwrites an agent edit (pi `docs/extensions.md`, the file mutation queue) |
| `HonestFormatClaim` | what the drain reports as its format (`summary.changed`, the notice, the `fixes` provenance, `recordWritten`) holds no agent edit |
| `LspMatchesDisk` | once quiet, an open LSP document holds the bytes on disk; this is also the no-drop direction of the stamp filter and of the session guard on the drain's sends. A retired service has no open document until its session's next touch |
| `NoBlindAllow` | an edit is admitted only after this session showed the agent F |
| `NoCrossSessionWrite` | a drain claimed in one session writes none of the next session's state (catalog shape 22), and opens no document in its fresh LSP service. The R1 resync of a document the next session already holds is not such a write |
| `NoDrainRespawn` | a drain never opens a document on an LSP service retired since it started (#234, #3576) |
| `NoOwnDrop` | a drain still in its own session keeps every session write (shape 54, the generation guard's no-drop direction) |
| `NoInstallHold` | an agent edit never waits on pi's queue while the formatter only resolves its command (#3558, #3610) |

## Results

TLC 2.19 (`tla2tools.jar` v1.7.4), `-workers auto`. The configs named after
a bug now model the fixed code. Each fix part keeps a violated witness, so a
change that drops it turns the check red.

| Config | Models | Expect | Distinct states |
|---|---|---|---|
| `Sequential` | before the fixes, interactive host | pass | 363 |
| `SequentialWide` | the same, wider bounds | pass | 2,723 |
| `OverlapLostEdit` | fixed code (#3527), next run overlaps the drain | pass | 698 |
| `OverlapClaim` | fixed code (#3527) | pass | 698 |
| `OrphanLostEdit` | fixed code (#3527, #3610), the bound abandons the run; checks `NoInstallHold` | pass | 1,787 |
| `OverlapLsp` | fixed code (#3529) | pass | 698 |
| `OrphanLsp` | fixed code (#3529, #3728, #3828): the post-exit wait gives up and still resyncs the late write | pass | 1,787 |
| `Straddle` | fixed code (#3528), `/new` during the drain | pass | 978 |
| `StraddleState` | fixed code (#3528), `/new` and an abandoned child | pass | 4,865 |
| `Fix` | all fix parts; overlap, orphan, `/new` and a retire without a session bump on | pass | 24,230 |
| `FixWide` | all fix parts, 3 edits, 6 ops, 3 runs | pass | 229,214 |
| `FixNoQueue` | without `FixQueue` (the drain before #3561) | violated `NoLostEdit` | 1,256 |
| `FixNoQueueClaim` | the same, checking the claim | violated `HonestFormatClaim` | 664 |
| `FixNoHold` | the hold released at the bound | violated `NoLostEdit` | 1,773 |
| `FixNoGen` | without `FixGen` (the code before #3528) | violated `NoBlindAllow` | 2,359 |
| `FixNoGenState` | the same, checking session state | violated `NoCrossSessionWrite` | 226 |
| `FixNoLspGen` | without `LspGen` or `ServiceGen` (the round-0 code of #3528) | violated `NoCrossSessionWrite` | 1,289 |
| `FixNoStartGen` | without `StartGen` or `HeldResync`: the old drain formats a file the new session has open | violated `LspMatchesDisk` | 1,935 |
| `FixNoHeldResync` | without `HeldResync` (the code before #3576): the #3528 R1 trace | violated `LspMatchesDisk` | 1,979 |
| `FixNoServiceGen` | without `ServiceGen` (the code before #3576): a retire without a session bump | violated `NoDrainRespawn` | 3,821 |
| `MutGenDropsAll` | the guard drops every write | violated `NoOwnDrop` | 198 |
| `MutGenDropsAllLsp` | the guard drops every drain send, the held resync included | violated `LspMatchesDisk` | 1,150 |
| `FixNoStamp` | without `FixStamp` (the code before #3529) | violated `LspMatchesDisk` | 2,796 |
| `OrphanNoLateSync` | without `OrphanLateSync` (the code merged in #3728): the give-up reports `abandoned` and the late write is never synced (#3828) | violated `LspMatchesDisk` | 327 |
| `FixNoLateSync` | the same on the full model (`/new`, retire, overlap) | violated `LspMatchesDisk` | 2,136 |
| `InBandLsp` | fixed code (#3858): the in-band caller's bound gives up, its tail sends the bytes from before the write, and the late write is resynced | pass | 2,598 |
| `FixInBand` | all fix parts on the in-band caller; overlap, orphan, `/new` and a retire on | pass | 83,918 |
| `InBandNoLateSync` | without `OrphanLateSync` at the in-band call site (the code before #3858) | violated `LspMatchesDisk` | 370 |
| `FixInBandNoLateSync` | the same on the full model | violated `LspMatchesDisk` | 3,230 |
| `InBandNoStamp` | without `FixStamp` on the in-band caller: the tail's unstamped send can land after the late resync | violated `LspMatchesDisk` | 593 |
| `FixEnterEarly` | without `EnterAfterResolve` (the code before #3610): an install holds pi's queue | violated `NoInstallHold` | 164 |
| `FixNoOrphanSync` | without `FixOrphanSync` (the code before #3529) | violated `LspMatchesDisk` | 594 |
| `MutNoReset` | non-vacuity: `/new` keeps the read guard | violated `NoBlindAllow` | 601 |
| `FixMtime` | mutant of #3520: the mtime fallback back on (the code before it) | violated `NoBlindAllow` | 660 |
| `FixExtProcess` | residual: another pi-lens process formats F | violated `NoLostEdit` | 160 |

Distinct states at the violation for the violated configs. #3576 made every
count grow: the agent's read now sends, and the service generation is state.
#3828 grew them again: the run's start is three steps (`DStart`,
`SubResolved`, `SubEnter`), the bound can abandon a run in any of them, and
the give-up (`OrphanGiveUp`) is state (`gaveUp`).

Two fix parts now overlap in the model, and the code keeps both:

- `ServiceGen` covers `/new` for the LSP sends on its own, because
  `NewSession` always retires the service (`session_start` resets it unless
  `--no-lsp`, where the drain sends nothing). `FixNoLspGen` therefore turns
  both off. The code's session half is what the replays in
  `tests/clients/format-drain-formal.test.ts` pin with a session reset alone.
- `HeldResync` covers the LSP consequence `StartGen` was the witness for, so
  `FixNoStartGen` turns both off. The start check still keeps a replaced
  drain from writing files the next session edits.

## What the model does not cover

- **The in-band caller's start (#3858).** `InBand` changes only what the
  bound's expiry does. The run still starts at `EndRun` as the model's one run;
  the real in-band caller starts it inside the agent's own `tool_result`, which
  holds that turn, so the agent cannot overlap it. The model's agent can
  overlap a run (`Overlap`), a superset of that. The pipeline's other
  phases (autofix, dispatch) are not modelled; its LSP send of the final read
  is `DApply`.
- **A run that never settles** (an install without a leaf bound). The late
  resync is chained on the run's settlement, so a run that never settles is
  never synced, and owes nothing: it never writes. Without fairness the model
  cannot show that the continuation parks no task; the replay
  `AbandonedInstall (#3599)` in `tests/clients/format-drain-formal.test.ts`
  pins that the give-up leaves one `abandoned` row and no late row.
- **The hold's release (liveness).** The model has no fairness, so a hold
  that is never released cannot show up as a violation. The code mutation
  that never releases it reds five cases in
  `tests/clients/format-drain-formal.test.ts`.
- **Another pi-lens process** (`FixExtProcess`) is outside this process's
  queue. An in-place `--write` child cannot do the compare-and-swap write
  that would close it.
- **#3520** (`FixMtime`): the read guard's mtime fallback admitted a
  session-2 edit from the drain's write alone. The code no longer has the
  fallback; `FixMtime` keeps it on as a mutant. This model has no no-drop
  witness for the zero-read arm: `EditCheck` counts every zero-read admit as
  blind (`blind' = blind \/ ~reads`), so any admit that an own-write action
  earned without a read would count against `NoBlindAllow`. That direction is `formal/read-guard`
  `BashAuthored`.
- **The actionable-warnings phase** at the end of the drain writes through
  its own mutation context and is not modelled. Since #3576 it starts only
  while the drain's session and LSP service are current, starts no edit after
  `/new`, and its in-flight edit's bookkeeping drops; the replays are in
  `tests/clients/format-drain-formal.test.ts` and
  `tests/clients/actionable-warnings-agreement.test.ts`.
