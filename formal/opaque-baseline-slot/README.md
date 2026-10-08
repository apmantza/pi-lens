# Opaque baseline slot model

A TLA+ model of three things: the pending opaque baseline that a bash call
records at `tool_call` and takes at `tool_result`, the dispatch dedupe that
its recoveries feed, and the inline blocker record those dispatches write. The baseline store is `OpaqueBaselineStore` in
`clients/opaque-mutation-scan.ts`. Its record site is `handleToolCall` in
`clients/runtime-tool-call.ts`, and its take site is `handleToolResult` in
`clients/runtime-tool-result.ts`. The dedupe is `claimPipelineDispatch` and
`dispatchPipelineAnalysis`, both in `clients/runtime-tool-result.ts`. Every
config states its expected verdict on its first line. The `TLA+ models` CI job
(`node scripts/check-tla-models.mjs`) checks them all.

Issue: #4137. Lane M5 of #3803.

## What the model covers

- **Calls.** There are three bash calls. Each records a baseline, runs, takes a
  baseline, and dispatches. pi runs the calls of one assistant message in
  parallel, at top level and in a codemode `Promise.all` alike, so any
  interleaving is allowed. `Sequential` restricts the model to orders in which
  no two calls overlap.
- **Scenarios.** Each scenario gives every call the paths its text names, the
  paths it writes, and whether it fails or is blocked:
  - `s8`: each call names and writes its own path.
  - `namedSibling`: call 2 names a path and writes nothing. Opaque call 3
    writes that path and also call 1's path, before or after call 1's dispatch.
  - `failedSibling`: call 2 names a path and fails (`isError`). Opaque call 3
    writes that path.
  - `blockedNamer`: call 1 names a path and is blocked, so it never runs and
    never gets a `tool_result`. Opaque calls 2 and 3 write the path, in call
    1's turn or the next.
- **The store.** `Record` stores a baseline under the call's key. With
  `Retire`, it first retires every entry whose turn is over. A baseline under
  the same key is overwritten, and on a full store the oldest is dropped
  (`OPAQUE_BASELINE_PENDING_CAP`). `Abandon` covers a call that pi never sends
  a result for: a `tool_call` handler blocked it, or Escape aborted it before it
  started. `NextTurn` ends a turn once no call is in flight.
- **The recovery.** A call's window holds every path written since its
  baseline's owner recorded. A path the call names that changed in the window
  is dispatched with authorship. The rest of the window is opaque and is
  dispatched without authorship (#3226). With no baseline, the named paths are
  dispatched without authorship.
- **The dedupe.** A claim is skipped when this turn's latch holds the same
  bytes and that analysis satisfies the claim. With `Dedupe = "content"` (the
  pre-fix rule), any analysis satisfies any claim. With `"authority"` (the
  fix), an analysis without authorship satisfies only a claim without
  authorship. The latch (`lastAnalyzedStateByFile`) is kept apart from the
  `analysed` history the invariants read: index.ts clears it at every
  session's turn start, a concurrent secondary's included (#3613), and with
  `LatchClear` the action `SecondaryTurnStart` may clear it at any time.
- **The record.** `rec` is the path's inline-blocker record and `recVer` the
  version its authored verdict is about. A dispatch with authorship records
  it. One without authorship clears it, except, with `ClearRule = "bytes"`
  (round 3), when the path's bytes are the very version the authored record is
  about: `clearInlineBlockers` refuses that clear, because a run without
  authorship withholds the blocker channel (#3226) and so proves nothing about
  those bytes. `"always"` is the clear before round 3.
- **Knobs.**
  - `Keying = "cwd"` is the pre-fix store (one key per `cwd:generation`).
    `"call"` is one key per tool-call id.
  - `Subtract` is round 1's sibling subtraction: a recovery leaves out the names
    of every pending entry and of every call that took after this one recorded.
  - `Observe = "counted"` is the degradation ledger's `opaque-baseline-lost`
    count. `"none"` is the pre-fix `evictionCount`, which no production code
    read.
  - `LatchClear` admits a concurrent session's turn start, which clears the
    dedupe's latch and nothing else (#3613).
  - `ClearRule = "bytes"` is round 3's refusal; `"always"` the clear before it.
    The configs that model pre-fix or round-1 code carry `"always"`; the rule
    is inert in them, because their dedupe never lets an unauthored dispatch
    reach authored bytes.

## Invariants

- `EveryWriteAttributed`: a finished, successful call has an authored analysis
  of every path it named and wrote.
- `BlockerKept`: if no other call writes the path, its blocker record is
  still the authored one.
- `NoDrop` (shape 54, the no-drop side): once no call is in flight, the latest
  bytes of every written path have been analysed, unless a counted loss took
  the writer's baseline.
- `SlotLossObservable`: every overwritten, evicted, or retired baseline is
  counted exactly once, and a call that finds no baseline never goes
  unrecorded.
- `StaleRetired`: once the current turn has recorded, no entry from an earlier
  turn is left. This is the bytes bound: on a non-git project each entry holds a
  stat snapshot of the whole tree.
- `RetiresOnlyAbandoned`: retirement never takes a call that can still get its
  result.
- `StaleRecordCleared`: the clear rule's other half. An authored record about
  older bytes does not outlive an unauthored analysis of the path's current
  bytes; the refusal covers the very bytes the verdict is about, nothing wider.

## Configs

States are as TLC reported them with `-workers 1` (generated / distinct).

| Config | Expect | States | What it proves |
|---|---|---|---|
| `CwdKeyedSlot` | violated `EveryWriteAttributed` | 122 / 105 | The pre-fix store. A later `Record` overwrites the earlier baseline, and that call finds nothing at `Take` (the S8 trace: `RECORD x3`, then a take that finds a baseline, then two that find none). |
| `CwdKeyedUncounted` | violated `SlotLossObservable` | 6 / 6 | The pre-fix observability: an overwrite left no record. |
| `PerCallKeyed` | pass | 6142 / 3251 | The fix on S8. All three calls keep authorship and their blocker records, nothing is dropped, and stale entries are retired. |
| `PerCallSecondaryTurn` | pass | 17766 / 8217 | VERIFY_4159 N1, fixed. A concurrent session's turn start may clear the latch at any time, so an opaque sibling's recovery of authored bytes runs; the clear rule keeps the authored record. |
| `Round2SecondaryTurn` | violated `BlockerKept` | 2554 / 1504 | Round 2 under the same latch clear (the verifier's TC mutant as a config). The opaque sibling's run proceeds and its clean result clears the authored record. |
| `PerCallContentDedupe` | violated `EveryWriteAttributed` | 1281 / 791 | Keying alone is not enough. The first call to take claims its siblings' paths as opaque, and the content dedupe then skips their authored dispatch of the same bytes. This is the keying-only run of the parallel-bash test: 1 of 3 authored. |
| `PerCallNamedSibling` | pass | 1926 / 971 | The fix on REVIEW_4159 F2 P1 and P2. |
| `PerCallFailedSibling` | pass | 2449 / 1171 | The fix on F2 P2e. Call 1 keeps its blocker record. |
| `PerCallBlockedNamer` | pass | 752 / 374 | The fix on F1. Every later write is analysed, and the blocked entry is retired with its turn and counted. |
| `Round1NamedSibling` | violated `NoDrop` | 1161 / 697 | Round 1's design (subtraction plus the content dedupe). Call 1 dispatches its path. Call 3 then writes it again, and the settled claim subtracts that write from call 3's recovery (P1). |
| `Round1BlockedNamer` | violated `NoDrop` | 261 / 173 | Round 1 on F1. The blocked call's pending entry subtracts the path it names from a later opaque writer's recovery. |
| `PerCallNoRetire` | violated `StaleRetired` | 41 / 39 | Without retirement, the blocked call's entry outlives its turn. |
| `PerCallOverCap` | pass | 11644 / 6094 | More parallel calls than the cap. The oldest baseline is dropped and counted, and no write goes unanalysed without a counted loss. |
| `PerCallOverCapUncounted` | violated `SlotLossObservable` | 19 / 19 | A cap eviction without its ledger record is a silent loss. |
| `SequentialSingle` | pass | 121 / 108 | Today's rows. Calls that never overlap share the one cwd slot without loss, under the pre-fix keying and dedupe. `PerCallKeyed`'s state space includes every sequential order. |

## Counter-checks

Each knob has a config that flips when it is turned:

- `Keying`: `PerCallKeyed` to `CwdKeyedSlot`.
- `Dedupe`: `PerCallKeyed` to `PerCallContentDedupe`.
- `ClearRule`: `PerCallSecondaryTurn` to `Round2SecondaryTurn`.
- `LatchClear`: `PerCallSecondaryTurn` to `PerCallKeyed` (the same fix, without the
  secondary's turn start; the round-2 spec passed there and failed only once the
  latch could go).
- `Subtract`: `PerCallNamedSibling` to `Round1NamedSibling`, and `PerCallBlockedNamer` to `Round1BlockedNamer`.
- `Retire`: `PerCallBlockedNamer` to `PerCallNoRetire`.
- `Observe`: `CwdKeyedSlot` to `CwdKeyedUncounted`.
- The cap: `PerCallKeyed` to `PerCallOverCap`.

The spec mutants run for round 2 each red the invariant named here:

- `Key(w) == 0` reds `EveryWriteAttributed` on `PerCallKeyed`.
- Subtracting every other call's names, whatever the overlap (REVIEW_4159's over-subtract mutant), reds `NoDrop` on `PerCallNamedSibling`.
- An authority check that requires an exact match, so an opaque claim proceeds past an authored analysis, reds `BlockerKept` on `PerCallKeyed`.
- Dropping the authority check reds `EveryWriteAttributed` on `PerCallKeyed`.
- Retiring live entries reds `RetiresOnlyAbandoned` on `PerCallKeyed`.
- Leaving a retirement uncounted reds `SlotLossObservable` on `PerCallBlockedNamer`.

Removing the dedupe altogether turns `PerCallContentDedupe` to pass, which ties that violation to the dedupe.

The spec mutants run for round 3:

- Neutering the clear rule (`Keeps(p) == FALSE`) reds `BlockerKept` on
  `PerCallSecondaryTurn`.
- Dropping the version comparison from the rule (keep whenever the record is
  authored) reds `StaleRecordCleared` on `PerCallNamedSibling`, where call 3
  rewrites the path call 1 recorded.
- Making the dedupe read the `analysed` history instead of the latch turns
  `Round2SecondaryTurn` to pass: a model whose dedupe cannot lose its latch
  cannot see N1.

## What the model cannot see

- Time and the clock. Windows are ordered by record, write, and take steps, not
  by `startedAt` and mtime (`OPAQUE_MTIME_TOLERANCE_MS`).
- Window attribution. A call that names a path a sibling wrote inside its window
  dispatches that path with authorship. Master behaves the same way; the model
  allows this and checks no invariant against it.
- Concurrency inside a dispatch. Each call's dispatch is one atomic step, so the
  in-flight registry (one run per hash and authority) and an unauthored run that
  settles after an authored one are not modelled. The write-order token
  (#3507) orders those two inline verdicts in the code, and the handler test
  `joins an authored run in flight instead of analysing its bytes without
  authorship` pins the in-flight half of the rank (VERIFY_4159 N2).
- A concurrent session's own calls. The model has one session's calls; the
  concurrent session appears only as `SecondaryTurnStart`, the one effect its
  turn start has on this seam. Retirement's liveness test is the coordinator's
  `isLiveTurnKey`, which keeps a subagent's live turn; the handler test covers
  that case.
- The same session's next turn against a record. `NextTurn` ends the turn once
  no call is in flight, so an opaque command of the next turn that touches a
  path with the same bytes is not modelled; the handler test `keeps an authored
  blocker across turns when an opaque rerun leaves the same bytes` covers it.
- The recovery itself (`recoverOpaqueChangesViaGit`, `captureFileStats`) and the
  pipeline. The model keeps only the dedupe and the inline record.

## Replay on the real code

`tests/clients/opaque-mutation-scan.test.ts` ("parallel bash calls (#4137)")
drives the real `handleToolCall` and `handleToolResult` over a real git
repository and the real store. Only the pipeline is mocked, at its process
boundary. It covers:

- three parallel calls, with sequential and concurrent results;
- the host without ids;
- the opaque sibling;
- F1's blocked namer;
- F2's three cells;
- both directions of the authority rank;
- retirement, and the concurrent session's live turn;
- the record kept through a concurrent session's latch clear and through the
  session's own next turn, and cleared on changed bytes (round 3).
