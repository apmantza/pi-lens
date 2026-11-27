# Blocker pending model

A TLA+ model of one file F and its inline-blocker record over a session. It
covers which blockers F's bytes hold, what each post-write dispatch observes,
and what the delta calls new. From those, it says what the record, the tool
result, the commit gate and the turn-end Resolved line report. Every config
states its expected verdict on its first line. The `TLA+ models` CI job
(`node scripts/check-tla-models.mjs`) checks them all.

Issue: #4484.

The seam:

- The delta split is `filterDelta(...)` in `clients/dispatch/dispatcher.ts`,
  keyed on `d.id`. Its held-back blocking set is
  `DispatchResult.heldBackBlockers`. The model reads the id; the cross-tool
  `findingKey` match is under "What the model cannot see".
- The pipeline's record, clean text and stored diagnostics are in
  `clients/pipeline.ts` (`recordBlockers`, `stillUnfixed`, `storedDiagnostics`).
- The record verb is `recordInlineBlockers` or `clearInlineBlockers`, called
  from `clients/runtime-tool-result.ts`.
- The clear refusal is in `clearInlineBlockers` in
  `clients/runtime-coordinator.ts` (`analysis.blocking`).
- Round 2: the runners' withheld findings (`RunnerResult.outOfEditScope`) and
  no-verdict runs (`reachedNoVerdict`, `clients/dispatch/types.ts`) become
  `DispatchResult.stillObserved` and `inconclusiveSources`. The pipeline's
  `carryRecordedBlockers` keeps a recorded blocker (`retainRecordedFindings`,
  `clients/finding-identity.ts`). A settled collect-later run retires its own
  runner's blockers through `retireSettledRunnerBlockers`
  (`clients/deferred-runner-blockers.ts`) and `retireUnobservedRunnerBlockers`
  (the coordinator).
- Round 3: the carry matches a recorded blocker only at its own line, aligned
  from the bytes it was read from to the current bytes
  (`clients/line-alignment.ts`, the coordinator's analysis anchor). A skip
  without a stated reason reaches no verdict (`reachedNoVerdict`). The lines a
  runner with no verdict covered join its next range
  (`DispatchContext.owedRanges`, `owedRangesAfterDispatch`).
- Round 5: each recorded entry carries its own line's text
  (`Diagnostic.lineHash`, `stampLineHashes`). With no usable position the
  carry matches it only on a line with that text, and owed lines are matched
  by content (`linesOwedByContent`, `owedByContentOnly` in
  `clients/line-alignment.ts`).
- Round 6: napi's Gate B skip (`clients/dispatch/runners/ast-grep-napi.ts`)
  says its verdict covers only the edit (`RunnerResult.editScopedVerdict`,
  `DispatchResult.editScopedRunnerIds`). The carry keeps such a runner's
  recorded blocker outside the edit, and `owedRangesAfterDispatch` keeps its
  owed lines outside the edit.
- Round 7: the skip names its covering lane (`RunnerResult.coveredBy`). The
  dispatcher reads it as no verdict when that lane did not answer, and
  `retireSettledRunnerBlockers` retires nothing on a settled covered skip.
- #4509: napi skips as covered only while it holds no recorded blocker on
  the file (`DispatchContext.recordedRunnerIds`); otherwise it runs, and its
  run names the lane too. Where the lane flagged the same rule on the same
  line, at least as severely, the lane's copy stands for the run's finding
  (`laneCopyStandsFor`): the dispatcher drops the run's copy, and the settle
  neither records nor observes it. Otherwise the settle retires as for any
  run. A kept entry with no place in the write's bytes is marked
  `Diagnostic.positionStale` instead of being inferred from one line's hash
  later, and `linesOwedByContent` skips lines with no word character.

## What the model covers

- **Findings.** `"a"` and `"b"` are blockers that a fast (inline) runner
  reports. `"d"` is a blocker that a collect-later runner reports (`Deferred`).
  `"u"` is an unused value (`Unused`): it blocks only while the delta calls it
  new. `"p"` (`Twin`) is a second occurrence of `"a"`'s rule, with `"a"`'s
  identity, already in the bytes at the start and never delivered unless a
  write changes its line.
- **Ids.** A finding's id is the one the delta keys on.
  - A line-bound id is `<<finding, line offset>>`. LSP ids work this way
    (`lsp:<code>:<line>`, `clients/dispatch/utils/lsp-diagnostics.ts`). A line
    inserted above the finding gives it a new id.
  - An ordinal id (`Ordinal`) is the finding's rank in the observation.
    helm-lint ids work this way (`helm-lint-<ordinal>-<level>`,
    `clients/dispatch/runners/helm-lint.ts`). Fixing an earlier finding
    renumbers the later one onto the fixed one's id.
- **Actions.** Each action maps to one row of the hook flow:

  | Action | Code step |
  |---|---|
  | `WriteStep` | An authored write or edit and its `tool_result` pipeline, run up to the record verb. `new` is the blocker set of the new bytes. `shift` inserts a line above every finding. `touched` is the findings on changed lines (`ctx.modifiedRanges`). |
  | `OpaqueStep` | An unauthored write (an opaque bash recovery, #3226) that introduces nothing. Its run withholds the blocker channel, so it can only keep or clear the record. |
  | `SettleStep` | The collect-later run of the current bytes settles, and its blocker joins the record (`recordDeferredInlineBlockers`). This happens at the commit gate or in the turn end's late lane, whichever asks first. |
  | `TurnEndStep` | `handleTurnEnd`. The late lane may or may not find the deferred run settled. The replay lists the record as unresolved. The Resolved line names F when a clear noted it and nothing is still unresolved. The record carries into the next turn. |

  Writes are sequential. How the record verb is ordered under parallel writes
  is `dispatch-pipeline`'s model (`InlineFix`, the write-order token).
- **Switches.**
  - `ClearOnCurrent` (the #4484 fix, pinned TRUE): the record, the clean text
    and the clear read the current blocking set. That is the observation's
    blockers, whether or not the delta calls them new. FALSE is the code before
    #4484: they read only the delta's blockers, so an empty delta clears the
    record.
  - `OpaqueKeep` (the #4484 fix, part 2, pinned TRUE): an unauthored run clears
    the record only when it observes no blocker. FALSE is the code before
    #4484: it cleared on any new bytes.
  - `Delta`: FALSE is `--no-delta`, the causal differential.
  - `RangeGated`: finding `"a"` comes from a runner whose edit-range gate
    withholds blocking matches on lines the write did not change (tree-sitter,
    and the ast-grep runners since #4482).
  - `MayFail`: a fast run, an unauthored run or a settling collect-later run
    may reach no verdict.
  - `Unused`: finding `"u"` exists.
  - Round 2 (#4484, each pinned TRUE). A recorded blocker leaves the record
    only when a conclusive observation from its own source shows it gone.
    FALSE is the round-1 code, where the record was the delivered set.
    - `ScopeDeliveryOnly`: an edit-range gate decides delivery only. A recorded
      blocker the gate withheld stays in the record; one never recorded does
      not enter it.
    - `CarryInconclusive`: a recorded blocker whose runner reached no verdict
      stays.
    - `CarryDeferred`: a recorded collect-later blocker stays while its
      re-check is in flight. A settled conclusive run of the current bytes that
      no longer observes it retires it and notes F Resolved when the record
      empties.
    - `CarryPromoted`: a recorded promoted unused value stays while the run
      still observes it.
  - Round 3 environment: `Twin` adds `"p"`; `MaySkip` lets a fast run skip
    without reading the bytes (a size or line cap, an aborted WASM runtime, an
    unavailable grammar or server).
  - Round 3 (#4484, each pinned TRUE; rules R1 to R4 of PR #4491's state
    table). FALSE is the round-2 code.
    - `CarryByPosition` (R2, R3): a recorded blocker is kept only by an
      observation of its identity at its own line. FALSE matched by identity
      alone and kept the observed copy, so a withheld `"p"` stood in for a
      fixed `"a"`.
    - `SkipNoVerdict` (R1): a skip without a stated not-applicable reason
      reaches no verdict. FALSE read such a skip as a conclusive, empty
      observation.
    - `OwedRanges` (R4): the lines a run with no verdict covered stay owed
      (the variable `owe`) and join the next run's range. An authored verdict
      discharges them; an unauthored run delivers nothing, so it discharges
      none. FALSE withheld a blocker first written while its runner had no
      verdict on every later run.
  - Round 4 environment: `MayUnalign` lets a write have no line alignment (an
    edit past the edit cap, a record without an anchor, bytes past the size or
    line caps). It matters only when lines moved (`shift`).
  - Round 4 (#4484, pinned TRUE; PR #4491's round-4 table).
    - `UnalignedIdentity`: with no alignment a recorded blocker matches its
      identity anywhere. A withheld `"a"` stays, and a withheld `"p"` may stand
      in for a fixed `"a"`: a false block, the fail-closed cost. FALSE is the
      round-3 code. It read the stale line number, found nothing, and retired
      a withheld `"a"` still in the bytes.
  - Round 5 environment: `TwinSameText` gives `"p"`'s line `"a"`'s text, so
    no line-content evidence tells them apart (#4481).
  - Round 5 (#4484, each pinned TRUE; PR #4491's round-5 table). FALSE is the
    round-4 code.
    - `UnalignedText` (K1): a match anywhere also needs the entry's own line
      text. FALSE matched by identity alone, so a pre-existing `"p"` with
      other text took over a fixed `"a"` and pinned (verify probe P22).
    - `StaleAnywhere`: an entry kept unmatched through a write with no
      alignment has no position (the variable `unpos`); a later aligned write
      matches it anywhere. FALSE aligned its stale line number, found nothing,
      and retired it while the bytes held it.
    - `OwedByContent` (K2): without an alignment to a record's bytes, a runner
      is owed the lines whose text matches an owed line. FALSE owed the whole
      file, so a pre-existing `"p"` no write reached became a new STOP
      (verify probe P23).
  - Round 6 environment: `GateB` lets the range-gated runner skip as covered
    by a primary (outcome `"cover"`). The primary's gate sees only the edited
    lines, not the runner's owed ones, and its copy has another identity.
  - Round 6 (#4484, each pinned TRUE; PR #4491's round-6 rows). FALSE is the
    round-5 code.
    - `EditScopedKeep` (N1): a recorded gated blocker outside the edit stays.
      FALSE retired it while the bytes held it (verify probe P27).
    - `EditScopedOwed`: the runner stays owed its earlier lines outside the
      edit. FALSE discharged them, so a blocker first written while it had no
      verdict never reached its range again.
  - Round 7 (#4484, each pinned TRUE; no new environment). The outcome
    `"silent"` (under `GateB` and `MayFail`) is a Gate B skip whose lane did
    not answer, and a collect-later Gate B skip may settle (`cv`).
    - `LaneVoids` (O2): a covered skip with a silent lane is no verdict. FALSE
      let the edit-scoped verdict stand (verify probe P33).
    - `SettleCoverKeep` (O1): a settled covered skip retires nothing. FALSE
      retired the collect-later blocker file-wide (verify probe P34).
  - #4509 (pinned TRUE). `RecordedRuns`: the gated runner takes no `"cover"`
    or `"silent"` outcome while the record holds one of its blockers, and a
    settle of d is never a covered skip while d is recorded. It runs, so its
    own verdict judges its own record. FALSE is the code before #4509: a
    failed write kept an entry whose line it edited without a position (P42;
    a write with no alignment the same, P38), and the edit-scoped keep, which
    never shows an unplaced entry inside the edit, kept it after its fix for
    the session. The model abstracts the lane's copy of the run's finding
    (same rule, same line, at least as severe) as the run's own delivery:
    both block, under another identity in the code. With it, the round-6 and round-7 switches act only on a file
    with no gated record (`LaneVoids` still owes the edit there) and on a
    race the model does not have: a settle absorbed between the dispatch's
    snapshot of the record and its carry (witness row 38).
    The as-built carry refines two rules for it: a failed write's kept entry
    whose line it edited joins `unpos`, and the edit-scoped keep holds an
    `unpos` entry whatever the edit.
  - #5727 (environment `PrimarySilent`; fix `CarryByServer`, pinned TRUE).
    The fast runner hosts two servers, as the `lsp` runner hosts a primary
    and the ast-grep auxiliary. On the outcome `"psilent"` the primary gives
    no answer while the auxiliary answers the bytes: "b" and "u" are the
    primary's findings and go unseen; "a" and "p" are the auxiliary's and are
    judged. The runner as a whole has no verdict, so the write's lines stay
    owed. `CarryByServer` keeps only the silent primary's recorded blockers
    (`answeredServerIds`). FALSE is the code before #5727: it kept every
    recorded blocker of the runner, so the auxiliary's fixed blocker pinned
    the commit gate and replayed as "Still unfixed".

## Invariants

- `GateHonest`: the commit gate is open, meaning there is no record, only when
  no completed observation of the current bytes holds a blocker.
- `CleanHonest`: a write's tool result says clean only when its observation
  holds no blocker.
- `ResolvedHonest`: F is reported resolved only when the run that cleared the
  record observed every blocker in it gone (the ghost `clearOk`). For an inline
  blocker, that is a conclusive run of bytes without it. For d, it is a
  settled conclusive run of the current bytes without it. A write never
  observes d, because its re-check is in flight.
- `GateSound`: the gate is open only when the bytes hold no fast blocker
  outside the lines a run with no verdict still owes (`owe`). This is stronger
  than `GateHonest`, because it also catches a blocker that a runner withholds
  or misreads. With `MayFail` and `MaySkip` FALSE nothing is owed, so it is
  round 2's `GateSound`.
- `RecordedReported`: the record holds only findings some run delivered (the
  ghost `reported`), so no observation stands in for a recorded blocker. The
  one exception is a finding a write with no alignment kept by identity (the
  ghost `held`), which is the fail-closed cost.
- `UnalignedKept`: a write with no alignment never retires a recorded blocker
  its bytes still hold (the ghost `lost`).
- `TwinNotAdopted`: a pre-existing, range-gated twin is never delivered or
  stood in by a write that did not reach its line (edited or owed) (the ghost
  `adopted`). A same-text twin (`TwinSameText`) is exempt: it is the #4481
  residual.
- `RecordedKept`: every blocker a run delivered stays in the record until a
  conclusive observation from its own source shows it gone (the ghost
  `owed`). It is the `GateSound` of a run that can fail, or of a value that
  blocks only when new: no write can block on a finding no run reported.
- `CleanSound`: a write's tool result says clean only when nothing reported
  was still owed at that moment (the ghost `cleanOk`).
- `ConclusiveRetires` (#4509): a write whose run reached a verdict never keeps
  a recorded blocker its bytes lack (the ghost `pinned`). A violation is a
  pin: fail-closed, but the fixed blocker holds the gate for the session.

## Configs

States are as TLC reported them with `-workers 1` (generated / distinct).

| Config | Expect | States | What it proves |
|---|---|---|---|
| `MutDeltaClear` | violated `GateHonest` | 53 / 21 | The code before #4484 (the issue's trace, below). Write 1 introduces E, the agent ignores it, and write 2 leaves E in place. The empty delta clears the record and the gate opens. |
| `MutDeltaClean` | violated `CleanHonest` | 53 / 21 | The same trace: write 2's tool result says clean while its observation holds E. |
| `MutDeltaResolved` | violated `ResolvedHonest` | 207 / 59 | The same trace, then a turn end that reports F resolved. |
| `MutDeltaClearOrdinal` | violated `GateHonest` | 20 / 10 | Ordinal ids are red too. The renumbering case (write {a, b}, then write {b}: b takes ordinal 1, which the baseline holds) is a trace of the same length. |
| `MutOpaqueClear` | violated `GateHonest` | 14 / 9 | The fix without part 2. An unauthored run of changed bytes that still holds E clears the record. |
| `ClearOnCurrent` | pass | 6298 / 830 | The fix, line-bound ids. It covers three writes, an unauthored write, two turn ends and a line shift. Every invariant holds, `GateSound` included. |
| `ClearOnCurrentOrdinal` | pass | 6298 / 830 | The fix, ordinal ids. Renumbering never clears a blocker that the observation still holds. |
| `NoDelta` | pass | 1627 / 239 | The causal differential. The code before #4484 under `--no-delta` is honest, so the defect needs the delta. |
| `DeferredGateHonest` | pass | 36411 / 4184 | The fix with a collect-later blocker. Whatever the deferred run's timing, the gate and the tool result stay honest. `GateHonest` counts a settled run only. That is the #3814 design: the commit gate absorbs a settled answer first (`absorbSettledRunnerBlockers`), and a run in flight does not gate. |
| `DeferredInFlight` | pass | 875 / 184 | The round-2 fix. A collect-later blocker stays recorded while its re-check is in flight. Only a settled run of the current bytes that no longer observes it retires it, so a Resolved line names F only after that run. |
| `MutDeferredInFlight` | violated `ResolvedHonest` | 743 / 150 | The round-1 code (`CarryDeferred` FALSE). A later write clears the record while d's re-check is in flight, and the turn end reports F resolved. |
| `RangeGatedResidual` | pass | 1623 / 310 | The round-2 fix. An edit-range gate decides delivery only, so a recorded E on an unchanged line stays recorded, an unauthored write included. `GateSound` holds. |
| `MutRangeGated` | violated `GateSound` | 20 / 10 | The round-1 code (`ScopeDeliveryOnly` FALSE). The gated runner never delivers E after an unrelated write, so the gate opens while E is in the bytes. |
| `CarryInconclusive` | pass | 384003 / 28064 | The round-2 fix. Any fast, unauthored or collect-later run may reach no verdict. A recorded blocker stays until a conclusive run of its source shows it gone, and no clean text or Resolved line rests on a failed run. Since round 3 it also holds `GateSound` and `RecordedReported`. |
| `MutFailClear` | violated `RecordedKept` | 182 / 26 | The round-1 code (`CarryInconclusive` FALSE). A write whose runner fails observes nothing, so the record clears. |
| `CarryPromoted` | pass | 4535 / 480 | The round-2 fix. A promoted unused value stays recorded on every later write that still observes it. |
| `MutPromotedClear` | violated `RecordedKept` | 183 / 46 | The round-1 code (`CarryPromoted` FALSE). The next unrelated write holds u back as already seen, and the record clears. |
| `CarryTwin` | pass | 66759 / 3926 | The round-3 fix (R2, R3). A pre-existing second occurrence of a recorded blocker's rule never keeps it once it is fixed, across three writes, an unauthored write, a turn end and a line shift. |
| `MutTwinIdentity` | violated `RecordedReported` | 57 / 27 | The round-2 code (`CarryByPosition` FALSE). The withheld twin p keeps the fixed a, recorded as p, which no run delivered (review F1, probes P9 and P10). |
| `CarrySkip` | pass | 13241 / 1626 | The round-3 fix (R1). A skip that never read the bytes keeps the record, and nothing reads the skip as clean. |
| `MutSkipVerdict` | violated `GateSound` | 13 / 6 | The round-2 code (`SkipNoVerdict` FALSE). A skip past a size or line cap clears the record while the blocker is in the bytes (review F2, probes P1 to P3). |
| `CarryOwed` | pass | 21224 / 1666 | The round-3 fix (R4). A blocker first written while its range-gated runner fails or skips is delivered and recorded by the next authored verdict, an unauthored write between them included. |
| `MutOwedRanges` | violated `GateSound` | 65 / 26 | The round-2 code (`OwedRanges` FALSE). Every later run withholds that blocker, so it is never recorded (residual a). |
| `CarryUnaligned` | pass | 128805 / 3926 | The round-4 fix, with round 5's. Across three writes that may each lack an alignment, an unauthored write, a turn end and a line shift, no recorded blocker the bytes still hold is retired, and no twin is adopted. |
| `MutUnaligned` | violated `UnalignedKept` | 93 / 19 | The round-3 code (`UnalignedIdentity` FALSE). A write with no alignment after a line moved retires a withheld blocker still in the bytes (verify probes P11c, P11d, P18). |
| `CarryStale` | pass | 122689 / 2745 | The round-5 fix. Writes may fail and lack an alignment: an entry kept without a position stays until a run shows it gone, and no twin is adopted. |
| `MutStaleAnywhere` | violated `RecordedKept` | 2747 / 232 | The round-4 code (`StaleAnywhere` FALSE). An aligned write after a failed write with no alignment retires the blocker while the bytes hold it. |
| `MutUnalignedText` | violated `TwinNotAdopted` | 276 / 53 | The round-4 code (`UnalignedText` FALSE). A pre-existing twin with other text takes over a fixed blocker (verify probe P22). |
| `MutOwedByContent` | violated `TwinNotAdopted` | 326 / 154 | The round-4 code (`OwedByContent` FALSE). A file with no record owes the whole file after a skip, and a pre-existing twin becomes a STOP (verify probe P23). |
| `CarryTwinText` | pass | 123337 / 2995 | The #4481 residual. A same-text twin may stand in (`held`); every other invariant holds. |
| `CarryGateB` | pass | 33555 / 1928 | The round-6 fix. The gated runner may fail, skip or take Gate B: a recorded blocker outside the edit stays, and its owed lines stay owed. |
| `CarryGateBTwin` | pass | 28729 / 1351 | The round-6 fix with a pre-existing twin: the keep holds only recorded blockers, so no twin is adopted. |
| `MutEditScopedKeep` | violated `RecordedKept` | 38 / 10 | The round-5 code (`EditScopedKeep` FALSE). Gate B's skip on an edit elsewhere retires a recorded blocker the bytes still hold (verify probe P27). |
| `MutEditScopedOwed` | violated `GateSound` | 128 / 26 | `EditScopedOwed` FALSE. Gate B's skip discharges the lines a failed write owed, and the blocker written then stays undelivered with no line owed. |
| `CarryGateBSettle` | pass | 16437 / 1366 | The round-7 fix. A collect-later Gate B skip may settle, and the gated runner's lane may stay silent: nothing retires without a run that read the bytes. |
| `MutSettleCover` | violated `RecordedKept` | 967 / 123 | The round-6 code (`SettleCoverKeep` FALSE). A settled Gate B skip retires a collect-later blocker the bytes still hold (verify probe P34). |
| `MutRecordedRuns` | violated `ConclusiveRetires` | 1208 / 131 | The code before #4509 (`RecordedRuns` FALSE). A failed write keeps a's entry without a position, and Gate B's covered skip then keeps it outside the edit after its fix: a pin (verify probe P42). |
| `CarryByServer` | pass | 160443 / 9894 | The #5727 fix. The fast runner's primary may be silent while its auxiliary answers: no fixed auxiliary blocker pins, and no recorded blocker of the silent primary leaves the record unseen. |
| `MutCarryByServer` | violated `ConclusiveRetires` | 1353 / 151 | The code before #5727 (`CarryByServer` FALSE). A run with a silent primary keeps the auxiliary's fixed, answered blocker: a pin. |
| `MutLaneVoids` | violated `RecordedKept` | 481 / 65 | The round-6 code (`LaneVoids` FALSE). With the server's host silent, the edit-scoped verdict retires a blocker on an edited line that still holds it (verify probe P33). |

The `MutDeltaClear` trace is write, ignore, write:

```
State 1: Init                 disk = {}     rec = {}     toolClean = TRUE
State 2: WriteStep            disk = {"a"}  rec = {"a"}  toolClean = FALSE   base = {<<"a", 0>>}
State 3: WriteStep            disk = {"a"}  obsF = {"a"}  rec = {}  toolClean = TRUE  noted = TRUE
```

## Counter-checks

Each switch has a config that flips when it is turned:

- `ClearOnCurrent`: `ClearOnCurrent` to `MutDeltaClear` (that config has no
  unauthored write, so `OpaqueKeep` is inert there).
- `OpaqueKeep`: `ClearOnCurrent` to `MutOpaqueClear`.
- `Delta`: `MutDeltaClear` to `NoDelta`.
- `Ordinal`: `ClearOnCurrent` to `ClearOnCurrentOrdinal` (both pass: the fix
  does not read the id), and `MutDeltaClear` to `MutDeltaClearOrdinal` (both
  red).
- `Deferred`: `ClearOnCurrent` to `DeferredInFlight` (both pass with the
  round-2 fix).
- `RangeGated`: `ClearOnCurrent` to `RangeGatedResidual` (both pass).
- `ScopeDeliveryOnly`: `RangeGatedResidual` to `MutRangeGated`.
- `CarryInconclusive`: `CarryInconclusive` to `MutFailClear`.
- `CarryDeferred`: `DeferredInFlight` to `MutDeferredInFlight` (the same
  scenario).
- `CarryPromoted`: `CarryPromoted` to `MutPromotedClear`.
- `CarryByPosition`: `CarryTwin` to `MutTwinIdentity` (`CarryTwin` with the
  switch FALSE is red on `RecordedReported` too).
- `SkipNoVerdict`: `CarrySkip` to `MutSkipVerdict`.
- `OwedRanges`: `CarryOwed` to `MutOwedRanges`. The discharge rule for an
  unauthored run is checked by hand: with `OpaqueStep` setting `owe' = {}` on
  a verdict, `CarryOwed` is red on `GateSound` (134 / 33).
- `UnalignedIdentity`: `CarryUnaligned` to `MutUnaligned`. `CarryUnaligned`
  with the switch FALSE is red on `GateSound` (285 / 60). With
  `RecordedReported` read strictly (no `held`), `CarryUnaligned` is red on it
  (288 / 62): a twin stand-in is the price of failing closed.
- `UnalignedText`: `CarryUnaligned` to `MutUnalignedText`.
- `StaleAnywhere`: `CarryStale` to `MutStaleAnywhere`.
- `OwedByContent`: `CarryStale` to `MutOwedByContent`.
- `TwinSameText`: `CarryStale` to `CarryTwinText` (both pass; the same-text
  twin is exempt from `TwinNotAdopted` and held under `RecordedReported`).
- `GateB`: `CarryOwed` to `CarryGateB` (both pass).
- `EditScopedKeep`: `CarryGateB` to `MutEditScopedKeep`.
- `EditScopedOwed`: `CarryGateB` to `MutEditScopedOwed`.
- `LaneVoids`: `CarryGateB` to `MutLaneVoids`.
- `SettleCoverKeep`: `CarryGateBSettle` to `MutSettleCover`.
- `CarryByServer`: `CarryByServer` to `MutCarryByServer`. The fail-closed
  direction is checked by hand: with `KP` keeping nothing on `"psilent"`,
  `CarryByServer` is red on `RecordedKept` (2977 / 392): the silent
  primary's blocker must stay.
- `PrimarySilent`: `CarryInconclusive` to `CarryByServer` (both pass).
- `RecordedRuns`: `CarryGateB` to `MutRecordedRuns`. `MutEditScopedKeep`,
  `MutLaneVoids` and `MutSettleCover` set it FALSE: with it TRUE their
  scenario (a covered skip over a gated record) cannot occur and they pass.

## Residuals TLC shows

Round 2 closed the two residuals round 1 named: a write that clears a
recorded collect-later blocker while its re-check is in flight
(`DeferredInFlight`, now a pass), and a range-gated runner that never
observes E after an unrelated write (`RangeGatedResidual`, now a pass).

Round 3 closed the failure-path half: a blocker first written while its
runner fails or skips is now delivered by the next authored verdict, because
its lines stay owed (`CarryOwed`, `GateSound` holds).

What remains is the gap before that verdict, and `CarryInconclusive`,
`CarrySkip` and `CarryOwed` leave `GateHonest` out for it. Until an authored
run reports such a blocker, the gate stays open; an unauthored run that
observes it first withholds the record (#3226). A blocker a range-gated runner
observes only outside the edit, on lines no run owes, is still never recorded
(#4481, by design).

## What the model cannot see

- Two lanes' copies of one finding (#4629). The model gives each finding one
  id. The code's delta also matches a finding that a different tool reports
  under the same `findingKey` (place, defect class, and the rule with a
  server's source prefix stripped; `clients/dispatch/dispatcher.ts`), so a
  language server's copy and the CLI's copy of one finding, which carry two
  ids, are one finding to it. That match only adds to the id's, and only across
  tools: two ids of one tool at one place and rule stay two findings. The model
  has one fast runner group and no pair of tools reporting one finding.
- Parallel writes and the write-order token (`dispatch-pipeline`'s `InlineFix`).
- Neighbour-file cascade baselines (`applyCascadeDeltaBaselines` in
  `clients/dispatch/integration.ts`). That is another file's record, a separate
  seam.
- A stale collect-later answer (one about older bytes). The model settles
  only the current bytes' run; the code refuses a stale one by the record's
  content hash and read time (`retireUnobservedRunnerBlockers`).
- Line alignment. The model's findings keep their atoms across writes, so a
  recorded blocker's position is exact. The code aligns lines by content hash
  (`alignLines`, bounded by `MAX_ALIGNMENT_EDITS`). The model reduces that to
  one choice per write, `MayUnalign`: with no alignment the code matches by
  identity and line text, counted as `blocker-position-unaligned`, and owed
  lines are matched by content. Text is one bit per twin (`TwinSameText`).
  Past `MAX_OWED_LINE_TEXTS` the code still owes the whole file, a bounded
  superset the model does not show.
- Per-runner owed lines. The model has one fast runner group; the code keeps
  owed lines per runner and widens only that runner's range.
- Gate B's positions. The model keeps a recorded gated blocker outside the
  lines the primary sees. The code keeps one outside the edit's ranges, or
  one it cannot place, so it keeps a superset; the primary also sees the
  language server runner's own owed lines, which the model leaves out.
- #4509's line evidence. `positionStale` makes the code's stale entry the
  model's `unpos` (recorded, where round 5 inferred it from one line hash),
  and a wordless line owed by content (#4509 N2) is a same-text collision
  the model's one text bit per twin already covers. The settle's match of
  a stale entry anywhere and the past-EOF sweep's skip of its line are not
  modelled; witness rows 39 and 35 replay them.

## Replay on the real code

`tests/index-4484-unfixed-blocker-witness.test.ts` drives the real extension
handlers (`tool_call`, `tool_result`, `turn_end`, the git guard). The LSP
service and the process spawn are doubled at their host boundary. Its cells:

- A: an LSP error that write 2 left in place, on every surface.
- C: a write that removes the error.
- B: an error moved by a line shift.
- I: the cross-turn case.
- K: the `--no-delta` differential.
- F and H: helm, before and after a line shift.
- R: helm renumbering.
- Round 6 (rows of PR #4491's round-6 table): 17 (P27, a napi blocker
  outside the edit under Gate B), 18 (one fixed on its own line retires) and
  19 (one fixed, one kept). Round 7: 26 (P33, a silent lane) and 24 (P34,
  a settled collect-later skip).
- #4509: 31 (P42, a fix after an edit the server missed), 31b (a fix while
  the server is cut off), 31c (a slow napi's run on the fix settles), 33
  (P38, a fix after a write with no alignment), 34 (P29, a stale entry whose
  old line now holds its text), 35 (a stale entry past the end of the file
  at turn end), 36 (P31b, a lone `}` owed by content), 37 (a covered skip
  with a silent lane owes the edit), 38 (a settle absorbed mid-dispatch) and
  39 (a stale entry when its runner's deferred run settles).
- Round 5 (rows of PR #4491's round-5 table): 4b (P22, a twin with other
  text), 6b (a stale entry), 9 (P23, owed by content) and 13 (P25, one entry
  after a settle).
- Round 4: rows 4 (P11c, P11d, the 2 MiB cap), 10 (P18) and 3 (P20).
- Round 3 (rows of PR #4491's state table): rows 6 (twins, ast-grep and
  tree-sitter), 7 (a moved blocker beside its twin), 11 (an LSP sync-limit
  skip, an ast-grep size-cap skip), 12 (a carried blocker moves with its
  line), 15 (owed lines) and 16 (a new error on a fixed one's id).
- Round 2 (rows of the PR's state table): ast-grep and tree-sitter blockers
  kept after an edit to another line (row 7), a pre-existing ast-grep finding
  that never blocks (row 8), an unanswered and a failed language server
  (row 10), a collect-later re-check in flight and its settle (rows 12 and
  14), and a delta-promoted unused value (row 16).

`tests/clients/opaque-mutation-scan.test.ts` covers part 2 ("keeps an authored
blocker when an opaque run of changed bytes still observes it (#4484)").
