# Cascade delivery model

A TLA+ model of what the cascade tells the agent about the import neighbours
of an edited file, turn after turn: the in-lane compute
(`clients/dispatch/integration.ts` `computeCascadeForFile`), the outstanding
silent-push touches (`clients/lsp/cascade-tier.ts`), and the turn_end render
with the pending error record (`clients/runtime-turn.ts` `handleTurnEnd`,
`clients/cascade-format.ts`). Every config states its expected verdict on its
first line, and the `TLA+ models` CI job (`node scripts/check-tla-models.mjs`)
checks them all.

Issues: #5804 (a neighbour pi rewrote with no language-server answer lost its
pending error at turn_end; `PiWrite`, `WriteSettle`, the `settle` stamp), #4485 (tier-3 neighbours deferred to a quiet window that mostly never
came, and runs that read clean with every neighbour unanswered), #4486
(snapshots and fallbacks from before the edit), #4487 (the rolling delta and
the recently-clean skip hiding a persistent error). #1712 is the live lane
over a real classic TypeScript server
(`tests/clients/cascade-classic-ts-live.test.ts`).

## What the model covers

One primary, two neighbours, one cascade run per turn, three turns. Each
neighbour's server follows one publish model, chosen at Init from `Models`:

| Model | Server | Publishes |
|---|---|---|
| `Pull` | pull diagnostics | answers a request at once |
| `CmdPull` | classic TypeScript (`typescript.tsserverRequest`) | on a change of verdict or a first open; answers the command at once |
| `Always` | pyright | after every notify |
| `Silent` | lua-language-server | on a change of verdict or a first open, so silence can mean clean |

Freshness is an epoch: `epoch` counts the primary's edits, and a cache entry
stamped with the current epoch was published after the edit the run is about.

| Action | What it abstracts | Source |
|---|---|---|
| `Edit` | the primary's write and notify; an open neighbour owes a publish per its model | `clients/runtime-tool-result.ts` (the dispatch), `clients/lsp/client.ts` (the notify) |
| `Publish(n)` | an owed publish lands in the client's per-file cache | `clients/lsp/client.ts` `getAllDiagnostics`, `getDiagnosticsVersionForPath` |
| `Compute` | the run: the recently-clean skip (mutant only), the passive snapshot, the touch per model and tier, the bounded in-lane wait, the degraded fallback, the delta (mutant only) | `integration.ts` `computeCascadeForFile`, `isPostEditObservation`, `SILENT_PUSH_WAIT_MS`, `appendFallbackNeighbors`; `cascade-tier.ts` `classifyCascadeWaitTier` (`command-pull`) |
| `LaterWrite` | a later write of the primary supersedes the run before turn_end | `runtime-turn.ts` consume filter (`cascade_carry_over_drop`) |
| `QuietWindow` | optional: the quiet window reconciles answered outstanding touches | `clients/quiet-window.ts`, `cascade-tier.ts` `reconcileOutstandingCascadeTouches` |
| `Expire(n)` | an outstanding touch ages out of the registry | `cascade-tier.ts` prune (`cascade_tier3_expired`, `deliverResolvedOutcome`) |
| `OutsideChange(n, k)` | the neighbour's file is written (`k = "write"`, a fix, a touch or a rewrite) by something pi never saw (git checkout, an external editor or formatter), or deleted (`k = "delete"`), between turns (`phase = "start"`) or between the compute's read and turn_end (`phase = "computed"`, #4495 round-2 verify R2-1); the server is not notified, and the cached publish and the record's observation (and, mid-turn, this run's) now predate the change | the filesystem; read by `runtime-turn.ts` `handleTurnEnd`'s `pendingGate` (`gateFindingsByPathFreshness`, quiet, per-entry `scannedAtOf: checkedAt`) |
| `PiWrite(n, a)` | pi itself writes neighbour `n` after the run's read (#5804); `a` is whether a language server answered for the write (`lsp` in the write's `verdictRunnerIds`, `answered`) or not (`unanswered`: inconclusive, crashed, timed out, superseded, never dispatched). The write is the agent's own: it sets neither `chg` nor `cacheChg` | `clients/runtime-tool-result.ts` (`noteCascadeWrite`), `cascade-format.ts` `settleCascadePendingAfterWrite` |
| `TurnEnd` | the registry peek, the run's section, the late answers, the unresolved and "changed since checked" lines (after the freshness gate), the record update | `runtime-turn.ts` `handleTurnEnd` (`peekOutstandingCascadeTouches`, the pending and unresolved sections), `cascade-format.ts` `recordDeliveredCascadeNeighbor` (stamped with `CascadeRun.checkedAt`, or no earlier than the settle for a file pi wrote with no answer), `forgetCascadePendingNeighbor` |

Out of scope, by design: two runs in one turn (turn_end's ownership pass gives
each neighbour to the last run that observed it; `cascade-turn-merge.test.ts`
covers it), a turn with no edit (a read-only turn renders no cascade section,
so no unresolved line either), the cap and its holds (`turn-end-delivery-holds`
models them), a primary with blockers (the cascade is skipped,
`skipReason: "blockers"`, by maintainer decision on #4485), commit gating
(neighbour errors stay advisory, same decision), and languages outside
`CASCADE_GRAPH_KINDS`.

## Invariants

- `NoCleanWithoutFreshObs`: a neighbour of a delivered run that the agent
  reads as clean (no error, no pending, no unresolved line) was observed clean
  after the edit.
- `NoErrWithoutFreshObs`: an error shown as this turn's was observed after
  the edit (an older answer renders as a labelled late one).
- `PersistentReserved`: an error the record held before turn_end, that no
  newer observation cleared and no outside change invalidated, is shown
  again: as this turn's error, as a late answer, or on the unresolved line.
- `NoUnresolvedAfterChange`: the unresolved line never names a neighbour
  whose file changed (or was deleted) after the observation its record holds
  (#4495 review F1; round-2 verify R2-1 for a change between the read and
  turn_end). Checked at the render, through the `staleClaim` flag the
  rendering `TurnEnd` sets.
- `NoSilentForget`: a recorded error whose file was written outside pi is
  never forgotten without the "changed since checked, not re-checked" line
  (#4495 round-2 verify R2-2); a deleted file's entry may go silently.
  Checked at the render through `silentDrop`. The line is forgotten only when
  delivered; that cut-line hold is `turn-end-cap-consumed-state.test.ts`'s,
  not the model's.
- `TouchEndsWithinBound`: every touch the run sent ends answered, or shown
  pending, in the same turn. The temporal form,
  `[](outstanding(n) => <>(answered(n) \/ pendingShown(n)))` under weak
  fairness on `TurnEnd`, is the same property; the model checks the bounded
  form as safety.
- `AnswerWhenAskable`: a neighbour whose server answers on request (`Pull`,
  `CmdPull`) is answered, never left outstanding.
- `ExpiryKeepsAnswer`: an answer that arrived for an outstanding touch is
  never dropped unread when the touch expires.
- `NoForgetAfterUnansweredWrite`: a neighbour error the model knows (held by
  the record, or observed this turn) is never forgotten after pi wrote the
  file with no language-server answer, unless a newer observation read it
  clean (#5804). The write is pi's own, so the "changed outside pi" line does
  not excuse the drop: the error may still be on disk, and a forgotten record
  is what lets the commit gate admit.
- `TypeOK`.

## Switches

The fix value first, then the as-built (pre-#4485) value.

| Switch | Fix | As built | Mutant config | Violates |
|---|---|---|---|---|
| `TierPath` | `"inLane"` | `"deferQuiet"` | `MutTierPath` | `AnswerWhenAskable` |
| `PassiveGate` | `"afterEdit"` | `"ttl"` | `MutPassiveGate` | `NoCleanWithoutFreshObs` |
| `FallbackGate` | `"afterEdit"` | `"ttl"` | `MutFallbackGate` | `NoErrWithoutFreshObs` |
| `RecentlyClean` | `FALSE` | `TRUE` | `MutRecentlyClean` | `NoCleanWithoutFreshObs` |
| `Delta` | `"none"` | `"rolling"` | `MutDelta` | `PersistentReserved` |
| `UnconfirmedMarker` | `"marked"` | `"none"` | `MutUnconfirmedMarker` | `TouchEndsWithinBound` |
| `ExpiryRead` | `"peekLog"` | `"drop"` | `MutExpiryRead` | `ExpiryKeepsAnswer` |
| `Reserve` | `"record"` | `"none"` | `MutReserve` | `PersistentReserved` |
| `PendingGate` | `"notify"` | `"none"` (#4495 round 1) | `MutPendingGate` | `NoUnresolvedAfterChange` |
| | | `"drop"` (#4495 round 2) | `MutPendingDrop` | `NoSilentForget` |
| `CheckStamp` | `"settle"` | `"delivery"` (#4495 round 2) | `MutCheckStamp` | `NoUnresolvedAfterChange` |
| | | `"read"` (#5804: no restamp) | `MutPiRestamp` | `NoForgetAfterUnansweredWrite` |
| | | `"carry"` (#5812 r2: restamp at the settle only) | `MutCarryStamp` | `NoForgetAfterUnansweredWrite` |
| `WriteSettle` | `"answered"` | `"forget"` (#5804) | `MutWriteSettle` | `NoForgetAfterUnansweredWrite` |

`PendingGate` and `CheckStamp` have the PR's own earlier rounds as their
as-built values, not master: master has no record. `CheckStamp = "settle"` is
`"read"` plus the settle stamp (#5804): a record kept after pi's unanswered
write moves its stamp to turn_end, and a record the same turn_end builds for
such a file from a read before the write takes that stamp too
(`runtime-turn.ts` `carriedKeys`), so the freshness gate reads the write as
carried whatever happens to the worklist next. With `"read"` the gate reads
the write as an edit outside pi, names the record once and forgets it.
`"carry"` restamps only at the settle, so a record built from a pre-write
read keeps the read bound until a later settle; it is safe only while the
worklist keeps the file (#5812 verify F4). `WriteSettle = "forget"` is master's unconditional forget at
turn_end for every pi-written neighbour. `OutsidePhases`, `OutsideKinds` and
`PiWriteAnswers` are scenario bounds, not switches (`PiWriteAnswers = {}`
turns `PiWrite` off, so every earlier config keeps its state count). `Merged` sets every switch
to its fix value and passes over three turns with between-turn writes.
`MergedOutside` sets the same fix values over two turns, the record's whole
life (delivered at the first turn_end, judged at the second), with writes
and deletes both between turns and between the read and turn_end. It passes.
The split keeps each config inside the CI shard budget: both timings and both
kinds over three turns is about 14 million distinct states. `MutPendingGate`,
`MutPendingDrop` and `MutCheckStamp` use `MergedOutside`'s bounds.
`MergedPiWrite` sets the fix values over two turns with both `PiWrite`
answers and no outside changes, and passes; `MutWriteSettle`, `MutPiRestamp`
and `MutCarryStamp` use its bounds with one switch flipped and each violates
`NoForgetAfterUnansweredWrite`. Not modelled in `MergedPiWrite`: an outside
write that lands before the restamp. The settle stamp moves over it too,
so the "changed since checked" line never fires for it; the record keeps
gating, so it fails closed (#5812 review F2, an accepted residual, which the
config's `OutsidePhases = {}` leaves out). The worklist (`pq`) is the code's:
a turn_end with no blocker clears it, and one that delivered a blocker keeps
it for fresh content or clears it (a repeat, a suppressed duplicate, or the
max-cycles turn_end after it), so `TurnEnd` picks either. `MutCarryStamp`
(the r2 shape) violates on the clear: TLC's trace delivers a blocker with
`pq` cleared, and the next turn names pi's write "changed" and forgets the
error. Not a model action: the forced max-cycles turn_end itself, which
renders nothing; the code settles the worklist before it clears it, pinned by
`cascade-turn-merge.test.ts` "a neighbour pi writes unanswered on a max-cycles
turn keeps its error after the worklist clears". `AsBuilt` sets every
switch to its as-built value; TLC's first counterexample is a stale clean
snapshot served for the edit (`NoCleanWithoutFreshObs`). Each mutant config
flips one switch and checks `TypeOK` with the invariant it breaks. Every
switch is pinned in `formal/switch-pins.json` to the test that drives the real
code.

## Running

```
node scripts/check-tla-models.mjs
```
