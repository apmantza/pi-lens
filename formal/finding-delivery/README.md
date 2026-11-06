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
| `cached` | a scanner store re-served every turn: gitleaks and trivy-secrets (`onMissing: "drop"`); govulncheck takes the same gate with `onMissing: "demote"`, which the model varies only as a mutant | the composer's shared freshness pass, then the lane's dispositions over both arms |

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
| `Mark` | the agent marks the cached finding false-positive; the mark anchors to the file's content when it is made (`tools/lens-diagnostic-mark.ts` reads the file at mark time), not to the content the agent was shown | `clients/diagnostic-dispositions.ts` `markDisposition`, `tools/lens-diagnostic-mark.ts` |
| `TurnEnd` | one turn_end delivery for both stores | `clients/runtime-turn.ts` `handleTurnEnd`: `pendingCandidates`, `pendingGate`, `forgetCascadePendingNeighbor`; `scannerGates`; `govulncheckLane.gate`, `secretsLane.gate` (`filterFindingsByDisposition`) |

Pending store, in `TurnEnd`: a turn whose run observed the file lists the
error (`full`) and records it, stamped by `StampAt`
(`cascade-format.ts` `recordDeliveredCascadeNeighbor`); a clean observation
newer than the record clears it (`ClearOnClean`,
`forgetCascadePendingNeighbor`). A turn whose
run did not observe it renders the record through `pendingGate`: `live`
renders the unresolved line, `stale` (written since the stamp) renders the
"changed since checked" line once and forgets the entry, `missing` forgets it
silently. A turn with no run renders no cascade section (`idle` phase).

Cached store, in `TurnEnd`: `missing` drops the finding (`onMissing: "drop"`,
the secrets lanes),
`stale` demotes it, `live` delivers it. The disposition policy then removes a
finding whose mark still applies, on the live arm and, under
`PolicyArms = "both"`, on the stale arm (#1617, #1625). A strict (false-
positive) mark applies only while the flagged line holds the content that was
marked (`Anchor = "line"`).

## Invariants

Every invariant below has a mutant config that violates it (the Switches
table names it), except `TypeOK`, which every config checks.

| Invariant | Statement |
|---|---|
| `NoUnresolvedAfterWrite` | the pending record never renders a neighbour "unresolved" when the file was written after the read behind it |
| `NoUnresolvedAfterDelete` | nor when the file was deleted |
| `NoSilentForget` | a written neighbour's record is never forgotten without the "changed since checked" line (demote, never drop) |
| `PersistentListed` | an error the record holds, on an unchanged file that no run observed this turn, is rendered again |
| `ListedWhenObserved` | an error a run observes is listed on every run |
| `MarkedNeverShown` | a finding whose mark still applies to the file is delivered on neither freshness arm |
| `NoSuppressRewritten` | a false-positive mark does not suppress a finding whose flagged line was rewritten |
| `NamedOnce` | a written neighbour is named "changed since checked" once; the entry is forgotten when that line is delivered, never named again |
| `NoNamedAfterDelete` | a deleted neighbour is forgotten silently, never named as changed |
| `CleanClears` | a clean observation newer than the record clears it; the record never keeps rendering an error a later run found fixed |
| `NoCachedAfterDelete` | the cached store never delivers a finding whose file was deleted after the scan (#1460) |
| `NoStaleCachedAtFull` | the cached store never delivers a finding at full authority (with its line) when its file was written after the scan |
| `NoCachedStaleDrop` | the cached store demotes a written file's finding; it never drops it |
| `TypeOK` | |

## Switches

The as-built value first, then the pre-fix value.

| Switch | As built | Pre-fix | Mutant config | Violates | Fix it reverts |
|---|---|---|---|---|---|
| `StampAt` | `"read"` | `"delivery"` | `MutStampAt` | `NoUnresolvedAfterWrite` | 297000e11, stamp pending errors at the read |
| `NeighbourGate` | `"freshness"` | `"none"` | `MutNeighbourGateNone` | `NoUnresolvedAfterDelete` | 0aaddeb79, gate pending neighbours by freshness |
| | | `"drop"` | `MutNeighbourGateDrop` | `NoSilentForget` | the #4495 round-2 shape that 297000e11 and 0aaddeb79 replaced |
| | | `"keepNamed"` | `MutNeighbourGateKeepNamed` | `NamedOnce` | the entry forgotten when its "changed" line is delivered |
| | | `"nameDeleted"` | `MutNeighbourGateNameDeleted` | `NoNamedAfterDelete` | the `missing` arm forgetting a deleted file silently |
| `Reserve` | `"record"` | `"none"` | `MutReserve` | `PersistentListed` | 123510076, deliver neighbour errors each turn (the pending record) |
| `Delta` | `"none"` | `"rolling"` | `MutDelta` | `ListedWhenObserved` | 123510076 (the rolling delta) |
| `PolicyArms` | `"both"` | `"liveOnly"` | `MutPolicyArms` | `MarkedNeverShown` | #1617, #1625 |
| `Anchor` | `"line"` | `"none"` | `MutAnchor` | `NoSuppressRewritten` | the strict anchor of a false-positive mark |
| `ClearOnClean` | `"clear"` | `"keep"` | `MutClearOnClean` | `CleanClears` | `forgetCascadePendingNeighbor` on a newer clean observation |
| `CachedGate` | `"freshness"` | `"keepMissing"` | `MutCachedKeepMissing` | `NoCachedAfterDelete` | the secrets lanes' `onMissing: "drop"` (#1460) |
| | | `"noStale"` | `MutCachedNoStale` | `NoStaleCachedAtFull` | the stale verdict: an edited file's finding keeps its line (#1622) |
| | | `"dropStale"` | `MutCachedDropStale` | `NoCachedStaleDrop` | demote, never drop, a finding whose file was edited |

`StampAt = "delivery"` and `NeighbourGate = "none" | "drop"` were the #4495
branch's own earlier rounds, not master: master never had them (the same note
as `formal/cascade-delivery`). The other mutant values (`keepNamed`,
`nameDeleted`, `ClearOnClean = "keep"`, every `CachedGate` value but
`"freshness"`) are single-line deletions of a gate rule, each checked against
the code's own test through the existing pins (`NeighbourGate`'s tests cover
`keepNamed` and `nameDeleted`; the two new pins cover the others); `"keepMissing"`
is also what the govulncheck lane does on purpose (`onMissing: "demote"`). `AsBuilt` sets every switch to its as-built
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
  the delivery rather than at the compute. The pending arm shares
  cascade-delivery's abstraction (an entry is a claim about the file at one
  tick, gated by freshness), so a change to the record's shape moves both. The
  two families stay separate: the
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
- The lane that takes `onMissing: "demote"` (govulncheck pins its CVE to
  go.mod): the model's missing-drop rule is the secrets lanes' policy, and
  `MutCachedKeepMissing` is the govulncheck policy applied to them. The
  late-auxiliary and late-runner drains drop a stale answer and re-arm
  instead of demoting (`formal/late-aux-drain`, `formal/pending-runner-store`).
- The fail-open verdicts: an unreadable path reads `live` (`unknown`), and the
  stat budget (`MAX_PENDING_NEIGHBORS` for the pending arm) past which a
  verdict is not taken.
- The read-only-turn early return: a turn with no run and no edit renders no
  pending section, so the record is not gated there (`idle` phase covers only
  the turn with no run).
- The #4617 provenance stamp (`clients/advisory-provenance.ts`
  `snapshotAdvisoryProvenance`): it validates an advisory message against the
  files it cites, a different gate from the finding-path verdict.
- Weak-anchored marks (defer, flagged, suppress), inline `pi-lens-ignore`
  comments and the `.pi-lens.json` rule policy; they are suppressors of the
  same shape as the strict mark, with no line anchor.
- The project-wide admission of a secondary session
  (`admitsProjectWideFindings`): no test drives a secondary turn_end for the
  project-wide stores, so a switch for it would have no pin.
- The pending record applies no disposition at render. Reproduced from the
  code: `runtime-turn.ts` (2531-2561) gates the record by freshness and never
  passes it through `filterFindingsByDisposition`, so a neighbour error the
  agent marks false-positive after it was delivered stays "unresolved" on
  every later turn until a fresh observation replaces the record. No config
  here encodes either behaviour; it is a defect for the maintainer to file, not
  a modelled gap.
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
the inputs, which is ADR 0010 section 11's "More families" bullet: this
family needs its own extractor and `Obs`.

## Running

```
node scripts/check-tla-models.mjs
```
