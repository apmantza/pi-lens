# Finding delivery gate model

A TLA+ model of the delivery gate (`clients/finding-delivery-gate.ts`, #1634):
the freshness, disposition and policy admission applied before a delivery
surface emits findings, seen from two stores that route through it, for one
cited file and one finding per store. Every config states its expected verdict
on its first line, and the `TLA+ models` CI job
(`node scripts/check-tla-models.mjs`) checks them all.

Issue: #4715. The gate file holds the contract and the surface registry
(`DELIVERY_SURFACES`); the code it names lives in `clients/runtime-turn.ts`
(`handleTurnEnd`), `clients/advisory-provenance.ts`
(`gateFindingsByPathFreshness`), `clients/turn-end/lanes/` and
`clients/diagnostic-dispositions.ts`.

## What the model covers

Two stores, either or both active (`Kinds`):

| Store | What it is | Gate stack it takes |
|---|---|---|
| `pending` | the cascade's pending neighbour-error record (#4487) | a run that reads the file lists its errors and stamps the record; a later turn whose run did not observe the file renders the record through the freshness gate |
| `cached` | a scanner store re-served every turn (govulncheck, gitleaks, trivy-secrets) | the composer's shared freshness pass, then the lane's dispositions over both arms |

Per delivery the order is: the freshness verdict of the cited path against the
entry's stamp (`missing`, `stale`, `live`), then the disposition policy over
what the gate returned, then the render. The order is structural (a lane's
`gate` receives the freshness partition, `clients/turn-end/lane.ts`;
`tests/config/turn-end-lane-boundaries.test.ts` pins that a lane never gates
itself), so the model has no switch for it.

Time is a logical clock. Every write, read, scan and delivery takes the next
tick, so "written after the read" is `mt > readAt`. Every violation flag is
computed from the true read time `readAt` and the file, never from the stamp
the gate judges against, so a wrong stamp cannot excuse itself.

| Action | What it abstracts | Source |
|---|---|---|
| `Write(lc, b)` | an outside write (git checkout, an external editor or formatter); `lc` says whether the flagged line changed, `b` is the new verdict | the filesystem; read as `mtimeMs` by `statFindingPath` |
| `Delete` | an outside deletion | the filesystem; `FindingPathFacts` `missing` |
| `Edit(cov)` | the turn's cascade run; it observes the neighbour when `cov`, stamped with the run's read bound | `clients/dispatch/integration.ts` `computeCascadeForFile` (`checkedAt: cascadeStart`) |
| `Scan` | the scanner takes a scan; the store's `scannedAt` is its start | `clients/advisory-provenance.ts` (store-freshness `Stamp = "start"`) |
| `Mark` | the agent marks the cached finding false-positive, anchored to the line it cites | `clients/diagnostic-dispositions.ts` `markDisposition`, `tools/lens-diagnostic-mark.ts` |
| `TurnEnd` | one turn_end delivery for both stores | `clients/runtime-turn.ts` `handleTurnEnd`: `pendingCandidates`, `pendingGate`, `forgetCascadePendingNeighbor`; `scannerGates`; `govulncheckLane.gate`, `secretsLane.gate` (`filterFindingsByDisposition`) |

Pending store, in `TurnEnd`: a turn whose run observed the file lists the
error (`full`) and records it, stamped by `StampAt`
(`cascade-format.ts` `recordDeliveredCascadeNeighbor`); a clean observation
newer than the record clears it (`forgetCascadePendingNeighbor`). A turn whose
run did not observe it renders the record through `pendingGate`: `live`
renders the unresolved line, `stale` (written since the stamp) renders the
"changed since checked" line once and forgets the entry, `missing` forgets it
silently. A turn with no run renders no cascade section (`idle` phase).

Cached store, in `TurnEnd`: `missing` drops the finding (`onMissing: "drop"`),
`stale` demotes it, `live` delivers it. The disposition policy then removes a
finding whose mark still applies, on the live arm and, under
`PolicyArms = "both"`, on the stale arm (#1617, #1625). A strict (false-
positive) mark applies only while the flagged line holds the content that was
marked (`Anchor = "line"`).

## Invariants

Each has a mutant config that violates it, so none is vacuous.

| Invariant | Statement |
|---|---|
| `NoUnresolvedAfterWrite` | the pending record never renders a neighbour "unresolved" when the file was written after the read behind it |
| `NoUnresolvedAfterDelete` | nor when the file was deleted |
| `NoSilentForget` | a written neighbour's record is never forgotten without the "changed since checked" line (demote, never drop) |
| `PersistentListed` | an error the record holds, on an unchanged file that no run observed this turn, is rendered again |
| `ListedWhenObserved` | an error a run observes is listed on every run |
| `MarkedNeverShown` | a finding whose mark still applies to the file is delivered on neither freshness arm |
| `NoSuppressRewritten` | a false-positive mark does not suppress a finding whose flagged line was rewritten |
| `TypeOK` | |

## Switches

The as-built value first, then the pre-fix value.

| Switch | As built | Pre-fix | Mutant config | Violates | Fix it reverts |
|---|---|---|---|---|---|
| `StampAt` | `"read"` | `"delivery"` | `MutStampAt` | `NoUnresolvedAfterWrite` | 297000e11, stamp pending errors at the read |
| `NeighbourGate` | `"freshness"` | `"none"` | `MutNeighbourGateNone` | `NoUnresolvedAfterDelete` | 0aaddeb79, gate pending neighbours by freshness |
| | | `"drop"` | `MutNeighbourGateDrop` | `NoSilentForget` | the #4495 round-2 shape that 297000e11 and 0aaddeb79 replaced |
| `Reserve` | `"record"` | `"none"` | `MutReserve` | `PersistentListed` | 123510076, deliver neighbour errors each turn (the pending record) |
| `Delta` | `"none"` | `"rolling"` | `MutDelta` | `ListedWhenObserved` | 123510076 (the rolling delta) |
| `PolicyArms` | `"both"` | `"liveOnly"` | `MutPolicyArms` | `MarkedNeverShown` | #1617, #1625 |
| `Anchor` | `"line"` | `"none"` | `MutAnchor` | `NoSuppressRewritten` | the strict anchor of a false-positive mark |

`StampAt = "delivery"` and `NeighbourGate = "none" | "drop"` were the #4495
branch's own earlier rounds, not master: master never had them (the same note
as `formal/cascade-delivery`). `AsBuilt` sets every switch to its as-built
value and passes. Each mutant flips one switch and checks `TypeOK` with the
invariant it breaks. `Kinds`, `OutsideKinds`, `CanMark`, `MaxClk` and
`MaxTurns` are scenario bounds. Every switch is pinned in
`formal/switch-pins.json` to the test that drives the real code.

## Relation to the neighbouring families

- `formal/cascade-delivery` owns the cascade compute (publish models, the
  registry of outstanding touches, expiry, late answers) and already carries a
  mutant per pending-record switch (`CheckStamp`, `PendingGate`, `Reserve`,
  `Delta`). This family reuses that vocabulary and drops everything upstream
  of the record: the entry is just "read at tick t". It adds what that family
  does not model: the cached-store arm (demote, dispositions over both arms,
  the strict anchor), the freshness verdict as a function of stamp, file and
  deletion for every store that calls the gate, and the invariants stated at
  the delivery rather than at the compute. The two families stay separate: the
  pending-record switches are coupled to the compute's observation model there,
  and removing them here would only move the same lines back.
- `formal/store-freshness` owns the stamp rules of the stores themselves
  (`Stamp = "start"`, the drift tolerance `ToleranceWindow`). The cached
  store's stamp is its scan start; this model does not vary it.
- `formal/turn-end-delivery-holds` owns the cap and the peek-then-commit
  holds. `TurnEnd` here always delivers, so a cut "changed" line (held, named
  on the next turn) is `tests/clients/turn-end-cap-consumed-state.test.ts`'s.

## Not modelled

- The 50 ms drift tolerance and mtime granularity (store-freshness).
- More than one file, finding or neighbour; a file re-created after a delete.
- The record's cap (`MAX_PENDING_NEIGHBORS`) and its eviction.
- `onMissing: "demote"` stores (govulncheck pins its CVE to go.mod) and the
  late-auxiliary and late-runner drains, which drop a stale answer and re-arm
  instead of demoting (`formal/late-aux-drain`, `formal/pending-runner-store`).
- Weak-anchored marks (defer, flagged, suppress), inline `pi-lens-ignore`
  comments and the `.pi-lens.json` rule policy; they are suppressors of the
  same shape as the strict mark, with no line anchor.
- The project-wide admission of a secondary session
  (`admitsProjectWideFindings`): no test drives a secondary turn_end for the
  project-wide stores, so a switch for it would have no pin.
- The pending record applies no disposition at render: a mark made after a
  neighbour error was recorded does not reach the unresolved line until a
  fresh observation replaces the record. No config here encodes either
  behaviour; it is a hypothesis for the maintainer, not a modelled gap.
- The render caps (`cascadeMaxFiles`, the display and message caps).

## Trace validation (ADR 0010, #4834)

Out of scope for this family. The tests that drive the gate with the real
gate, record and filesystem are `tests/clients/cascade-turn-merge.test.ts`
(the pending path; it spies the logger sinks and mocks nothing else of the
seam) and `tests/clients/runtime-turn-secrets-disposition.test.ts` (the cached
path). They are the candidate trace sources. They cannot be recorded yet
because production writes rows only for the gate's outputs
(`cascade_pending_gated`, `cascade_pending_rendered`,
`finding_stale_line_demote`, `finding_dead_path_drop`) and none for its
inputs: no row carries an outside write, a read bound, a scan or a mark. A
trace of outputs alone would check the model against itself. The stance changes
when a row (or a test-side recorder that logs the writes the test makes) names
the inputs, which is ADR 0010 section 11's "store writers" item for this
family.

## Running

```
node scripts/check-tla-models.mjs
```
