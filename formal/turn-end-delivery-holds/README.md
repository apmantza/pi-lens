# Turn-end delivery holds model

A TLA+ model of the turn-end composer's delivery holds
(`clients/turn-end/delivery-holds.ts`, wired in `clients/runtime-turn.ts`
`handleTurnEnd`). A producer that consumes one-shot state for a part cannot
know at compose time whether `capTurnEndMessage` will cut the part, so it
registers a hold; the composer judges every hold once against what the cap
kept and runs one callback per hold. Every config states its expected verdict
on its first line, and the `TLA+ models` CI job
(`node scripts/check-tla-models.mjs`) checks them all.

Issues: #3803 (model lane M1), #3813 (the holds and their chain of rounds),
#3900 (late auxiliary re-arm), #3901 and #4112 (the park-then-recheck carry
and its session key), #4161 (the drains fenced to the session current when
they run). #3999 and #3808 only reshape the parts a runner hold
names; they add no hold shape.

## What the model covers

Six items, one part each, over three hold shapes. Each row cites the source
the action abstracts.

| Shape | Item | Producer | Source |
|---|---|---|---|
| peek-then-commit | 1 | dependency-drift count, `skipOnSuppressed` | `runtime-turn.ts` `countDriftDeliveryOnDelivery` |
| peek-then-commit | 6 | past-EOF retirement (secondary's), settles delivered even when suppressed | `runtime-turn.ts` `retirePastEofOnDelivery` |
| drain-then-restore, bounded | 2 | late auxiliary pair, `canHold` = `canRearmPendingAuxiliary` (#3900) | `runtime-turn.ts` (the late auxiliary hold), `clients/lsp/pending-aux-coverage.ts` `canRearmPendingAuxiliary` |
| drain-then-restore, unbounded | 3 | settled runner result requeued (#3813); cascade run re-appended | `runtime-turn.ts` (the runner and cascade holds) |
| park-then-recheck | 4, 5 | cut-advisory park of the primary (4) and of a concurrent secondary (5) (#4112, #3901) | `runtime-turn.ts` `cutAdvisoryHold`, `runtime-coordinator.ts` `parkCutAdvisoryItems`, `takeCutAdvisoryItems` |

Actions, one per step of `handleTurnEnd`, per session `s`:

- `Start(s)`: `handleTurnEnd`'s entry captures the session scope
  (`runtime-turn.ts` `holdScope`). The drains below run after awaits, so a
  `SessionReplace` can land between `Start` and any of them (#4161).
- `NextTurn(s)`: the park lane's next successful run takes the entries under
  its key and keeps the ones it still reports (`takeCutAdvisoryItems`,
  `stillReportedParked` in `delivery-holds.ts`). A failed run leaves them
  parked, so the action is optional. Under `DrainFence = "access"` it runs
  only while the turn's session is current (`runtime-turn.ts` `takeParked`).
- `Compose(s)`: the producers push their parts in any order and size. A peek
  producer leaves its state alone; a drain or park producer consumes it. Every
  taken re-offer must appear in the message. Under `DrainFence = "access"` a
  turn whose session was replaced drains nothing: only peek parts compose
  (`holdScope.guardedWrite` around `consumeCascadeRuns`, the late auxiliary
  drain, and `settleCascadeRuns`' own `generation` check).
- `Skip(s)`: a started turn with nothing left to compose ends.
- `Cap(s)`: `planDeliveryHolds` and `capTurnEndMessage`. A part is reached when
  it lies whole inside the kept prefix, or leads the message and so could not
  fit alone (`delivery-holds.ts` `planDeliveryHolds`). `keeps` asks `canHold` once, before
  the message is final (`delivery-holds.ts` `planDeliveryHolds` (`keeps`)). The signature-dedupe verdict
  (the duplicate-findings suppression in `runtime-turn.ts`) is a free choice.
- `Settle(s)`: each hold runs once, guarded by `isCurrentSession`
  (`delivery-holds.ts` `settle`, `runtime-turn.ts` `settleHolds`). Reached parts
  commit (`onDelivered`, skipped on a suppressed turn for `skipOnSuppressed`);
  cut parts restore (`onHeld`) or are dropped with a record (`onDropped`).
- `SessionReplace`: `resetForSession` clears the session-scoped stores
  (`runtime-coordinator.ts` `resetForSession`). It is disabled between `Cap` and
  `Settle`, which are one synchronous block in the code, so no other action
  runs between them
  (`planDeliveryHolds` to `settleHolds` in `runtime-turn.ts` `handleTurnEnd`).
  A session index stands for the session and its successor, and runs one turn
  at a time, so the successor's own cut turn cannot run while the old turn is
  in flight. `SessionReplace` may therefore start the successor with its park
  lane already holding its item (`succParked`), for an owner whose turn is in
  flight: a same-id replacement (`session-lifecycle.ts`
  `classifySessionStart`, the same-session branch) keys that lane the same.

The park map is the item status itself (`parked` under a lane key), so a park
that replaces its lane's entry (`runtime-coordinator.ts` `parkCutAdvisoryItems`) is an
`evicted` status.

## Invariants

| Invariant | Statement |
|---|---|
| `NoLossByCap` | A part the cap cut is still pending after `Settle` (queued, peek-pending, or parked), unless it was dropped with a recorded reason. A re-armed pair the next drain retires undelivered, and a park the lane replaced, are losses. |
| `NoDoubleDelivery` | An item reaches the agent at most once per generation, and a parked item is re-offered only while its lane still reports it. |
| `NoPin` | A re-offered item is never parked again (the park-then-recheck note in `delivery-holds.ts`'s module header), and a leading part is never held (the reach rule in `delivery-holds.ts`'s module header). |
| `HoldFencedToSession` | A turn composes only its own session's items, no store entry carries a replaced session's generation, and a replaced session's `Settle` changes no store entry (delivered or held branch). |
| `NoStrand` | A turn whose session was replaced after its `Start` never takes a successor's item that the cap then cuts: its `Settle` is skipped, so nothing would deliver or restore it (#4161). |

## Configs

| Config | Expect | What it proves | States (generated / distinct) |
|---|---|---|---|
| `Merged` | pass | Merged master, with #4161's drain fence. | 9,644,498 / 4,518,616 |
| `DrainAtEntry` | violated `NoStrand` | The pre-#4161 shape: the scope is captured at `Start` and only `Settle` checks it. `Start`, `SessionReplace`, then `Compose` drains the successor's auxiliary pair, `Cap` cuts it, and the skipped `Settle` restores nothing. 6-state trace. | 23,011 / 15,181 |
| `PreCapCommit` | violated `NoLossByCap` | The producer commits at compose, before the cap (the shape #3813 removed): a cut peek part is gone. 5-state trace. | 3,717 / 3,163 |
| `NoCanHold` | violated `NoLossByCap` | The late auxiliary hold without `canHold`: `rearmPendingAuxiliaryCoverage` re-arms past its bound (`clients/lsp/pending-aux-coverage.ts` `rearmPendingAuxiliaryCoverage`), the next drain retires the pair, and `onDropped` never fires. 9-state trace. | 376,297 / 217,197 |
| `ReOfferUnbounded` | violated `NoPin` | A part showing only re-offers can be held (`canHold` always true): a cut re-offer is parked a second time. 10-state trace. | 695,475 / 419,533 |
| `ParkNoSessionKey` | violated `HoldFencedToSession` | The pre-round-2 park key of #4112: the secondary's lane run takes the primary's parked item and its message shows it. 6-state trace. | 20,677 / 12,897 |
| `MutNoLeadReach` | violated `NoPin` | Drop the `leadsOversized` clause (`delivery-holds.ts` `planDeliveryHolds` (`leadsOversized`)): a leading oversize part is held. | 3,211 / 2,677 |
| `MutNoLiveFenceDelivered` | violated `HoldFencedToSession` | The skip guards the held branch only, so `onDelivered` (retire past-EOF, bump the drift count) still runs after a replacement and writes the new session's store (`crossWrite`). The recurrence: `settle` has one `if (!live) continue` for both branches and a refactor could split them. 6-state trace. | 20,279 / 12,793 |
| `MutNoLiveFenceHeld` | violated `HoldFencedToSession` | The skip guards the delivered branch only, so `onHeld` still restores after a replacement with the old generation (`igen`). 6-state trace. | 21,567 / 13,917 |
| `MutUncheckedRecheck` | violated `NoDoubleDelivery` | `stillReportedParked` returns every parked item: a fixed item is announced again. | 221,019 / 172,913 |
| `MutRestoreReached` | violated `NoDoubleDelivery` | `onHeld` also runs for a reached drain part: the delivered state returns and reaches the agent twice. | 363,409 / 211,908 |

State counts for the violated configs are TLC's counts at the violation (one
worker, breadth-first, so deterministic). TLC 2.19, `-workers 1`.

`Merged` took 112 s locally with the first model and 246.6 s on the CI runner
(shard 1 went from 2m26s to 7m05s against the 12-minute job cap). Allowing only
`Settle` while a session sits between `Cap` and `Settle` (as the code is) cut
it to 2,402,000 distinct states, 64 s locally, with the same verdict. The
`Start`/`Compose` split and the successor's park (#4161) raise it to 4,518,616
distinct states, 112 s locally (`-workers 1`, the same host); an unrestricted
successor park (any owner, not only one with a turn in flight) cost 6,008,908
distinct states and 154 s for the same verdict.

The mutation proof for `Merged` (neutering a spec action, not a config
switch): replacing the drain restore with a no-op (`"msg"` for the restored
status in `PartSt`) and, separately, the park with a no-op flips `Merged` to
`violated NoLossByCap`. Removing `~crossWrite` from `HoldFencedToSession` makes
`MutNoLiveFenceDelivered` pass (2,873,235 distinct states), so the checker reds
it. #4161's fence, neutered one half at a time in `Merged`: `ComposeCands`
ignoring `MayDrain` violates `NoStrand` in 6 states (14,905 distinct; the
cascade and auxiliary drains), and `NextTurn` without `MayDrain` violates it
in 7 (66,610 distinct; the park take: `Start`, `SessionReplace` with the
successor's park, `NextTurn`, `Compose`, `Cap`, `Settle`). Without
`succParked` the second mutant passed, because the successor could not park
while the old turn was in flight.

## What the model cannot see

- **One size axis.** `capTurnEndMessage` cuts on lines and on chars
  (`runtime-turn.ts` `capTurnEndMessage`); the model has one budget. The reach rule is
  per part and does not read the axis.
- **One item per part.** A part that mixes re-offers and new items parks only
  the new ones and records the rest (`runtime-turn.ts` `cutAdvisoryHold`); the model
  has the all-new and all-re-offer cases, which are the cells the invariants
  are about. A part with no hold, and two holds on one part text
  (`delivery-holds.ts` `planDeliveryHolds` `byPart`), are not modelled.
- **Time.** The late auxiliary TTL is the `RearmMax` bound on restores
  (`clients/lsp/pending-aux-coverage.ts` `isPendingAuxiliaryPastRearmTtl`).
- **The lane bound.** `MAX_CUT_ADVISORY_LANES` (16) evicts the oldest parked
  lane with a record (`runtime-coordinator.ts` `MAX_CUT_ADVISORY_LANES`); the model has two lanes.
- **A replaced turn's message.** After a replacement the old turn still
  composes its peek parts (the successor's blockers, read through
  `getInlineBlockersSnapshot`) and persists the message for the current
  session. Nothing is consumed, so no invariant here is about it; which
  session that message belongs to is the #3758 family (lane M4).
- **One drain step per shape.** The code's drains run at several points of
  `handleTurnEnd`, each after its own awaits; the model has one `NextTurn` (the
  park take) and one `Compose` (every other drain) after `Start`. The runner
  store drains in the entry tick (before the first await), so `Start` and its
  drain are not split in the code either.
- **The producers' stores are process-wide, not session-keyed.** The runner
  store and the cascade runs are fenced by the live generation only, and the
  peek shape's store (`_pendingInlineBlockers`, read through
  `getInlineBlockersSnapshot`) has no session field, so a concurrent
  secondary's turn end can drain or compose a live primary's entries (the R2
  remainder of #4118; #3613, #3758 open). Only the park map carries the
  turn's session id. The model assigns each peek item an owner
  (`Owner`), a modelling choice that makes the first clause of
  `HoldFencedToSession` true by construction for items 1 to 3 and 6. Lane M4
  (`session-lifecycle`) owns these stores.
- **A secondary's own scope.** Both sessions read one coordinator generation
  (`gen`): `MayDrain` and `Settle`'s `trueLive` compare `hgen[s]` with it.
  That is the shipped identity for these stores (#4168 round 3: the hold
  drains and write-backs are fenced by the coordinator's scope, which owns
  them). A concurrent secondary's own retirement changes no modelled
  variable, so the cell "the secondary drains, then its own scope retires
  before `Settle`" (#4168 verify R2-F1) is a stutter here: `Settle` restores
  under `gen` exactly as the code restores under `holdScope`. It is pinned by
  the two secondary rows in `turn-end-cap-consumed-state.test.ts` (S1 and
  S4). The round-2 identity, which judged the secondary's settle by its own
  scope, cannot be expressed without a per-activation scope and an owner map
  for items 2 and 3 (`Owner` gives them to session 1 by construction); both
  are lane M4's. The one store the activation's scope owns, the late-scan
  cell, is lane M2's (`turn-end-late-scan`, whose settle reads `ended`).
- **The late scan family.** `runtime-turn.ts` `LateDeadCodeScan` is lane M2.

## Replay on the real code

The tests that pin the same cells through the real `handleTurnEnd`:

- `tests/clients/turn-end-cap-consumed-state.test.ts`: "retires a record whose
  advisory cannot fit the cap even alone (no starvation)" and the F2 group
  (`Lead`, `NoPin`); "does not hand a cut run back to a session that replaced
  the one it came from" (`Fence`); "does not re-arm a cut pair that is past
  its re-arm TTL" and "a pair cut on every turn stops re-arming at the ceiling
  and records the drop" (`DrainAsk`); "a dedupe-suppressed identical turn still
  consumes a fitting result" (the suppressed branch); the M1-M3 `CELLS` groups
  (`PeekCommit`).
- `tests/clients/turn-end-cap-edit-derived.test.ts`: "does not re-offer a cut
  item the next scan no longer reports" (`Recheck`); "bounds the carry: an item
  cut on two consecutive turns is dropped with one record" (`ReOffer`); "a
  same-root secondary turn neither takes nor shows the primary's parked item"
  and "a new session does not inherit a parked item" (`ParkKey`, `Fence`);
  the `#4161` group's per-lane rows, "$lane: the successor's parked item
  reaches the successor" for knip, dead-code and call-graph (`DrainFence`,
  the `NextTurn` half).
- `tests/clients/turn-end-cap-consumed-state.test.ts`, the #4161 group:
  "leaves the successor's cascade run and parked compute for the successor's
  own turn", "keeps the successor's run and drops the replaced session's
  compute that settles inside the settle wait", "leaves the successor's
  late-auxiliary pair pending" (`DrainFence`, the `Compose` half), and
  "restores both cut runs when no replacement lands" (the no-drop control).
