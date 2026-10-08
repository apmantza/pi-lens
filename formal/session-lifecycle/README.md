# Session lifecycle model

A TLA+ model of pi-lens' session-scoped stores across every pi session
transition. It began as slice S9 of the #3609 design (one session-scoped state
store) and is re-baselined (#3803, lane L1) on the merged slices: S1 (#3732,
scope tickets and the lineage handle), S3 (#3759, late writers fenced by the
captured scope) and S2 (#3777, the session hand-off), with #3757 (advisories
drained per scope) and #3668 (gap subagents kept off the primary slot). It is
the composition layer over the sibling models: content-level truth stays in
`formal/read-guard`, `formal/session-straddle`, `formal/format-drain` and
`formal/session-registry`. Every config states its expected verdict on its
first line (see `formal/file-locks/README.md`), and the `TLA+ models` CI job
(`node scripts/check-tla-models.mjs`) checks them all.

Four kinds of config:

- **Merged behaviour** (`Merged`, `MergedStores`, `H3FileBacked`) must pass,
  and so must #3819's fix (`H3FileLess`, `H3FileLessStores`,
  `H3FileLessCarry`, `H3StaleSlot`, `H3StaleSlotFileLess`, with `ticketKey`
  and `demotedDiscard`), and so must #3881's (`H3Interrupted`,
  `H3InterruptedFileLess`, with `forwardUnadopted` and `forwardPolicy`;
  #4113's `H3InterruptedUnstarted*` add `forwardUnstarted`), and
  so must #3855's (`H3DemoteCarry`, `H3DemoteAdvisory`, `H3DemoteActivation`,
  `H3DemoteFileLess`, `H3SecNew`, `H3SecNewFileLess`, `H3DemotedReplaces`,
  `H3StaleNoteResume`, `H3NoteEvicted`, `H3InMemoryNewGapReload`,
  `H3SdkBind`, `H3SdkBindFileBacked`, with `namedSuccessor`; `Merged`,
  `MergedStores`, `H3Interrupted*` and `H3FileLessCarry` carry it too, with
  `HasPrimary`), and so must #3613's turn half (`MergedTurns`). The rest
  register a known violation of merged master until its fix flips the
  config to `pass`: `Current` violates `NoCrossSessionState` through F4
  (the read-guard half of #3613), and
  `AcceptedSecondaryForkActivation` pins the answer #3855 gives for a
  subagent's own `/fork` (finding F6), and `AcceptedR3InMemoryNew` pins
  #3855's residual R3 (finding F7).
- **Design** (`Fix`, `FixProcess`, `FixOrder`, `NewestReadTreeFork`) is the
  adopted #3609 design, S4 included (a subagent gets its own read guard and
  turn counter). It is not #3819's fix: with `FileLess = {}` and no subagent
  replacement, `Fix` cannot reach either #3819 path. The `AcceptedLateRead*`
  configs pin the false block the design accepts (F1).
- **Pre-fix** (`PreS1*`, `PreS2*`, `PreS3*`, `Pre3757*`, `Pre3819*`, `Pre3881*`, `Pre3855*`) restores the shape a
  merged fix removed, and must violate the invariant that fix established.
- **Mut** configs remove one mechanism or restore one table row: older
  pre-fix shapes, today's open residuals, and design alternatives the design
  rejected. `Mut3855r1*` restore #3855's first round (`inheritRole`, the
  secondary notes) on the cells its review found (F7). The "Pre-fix and Mut
  configs" table says which.

## What the model covers

**Store content is abstracted to facts.** A fact `[e, o]` says "scope `o`
recorded something about the tool result at conversation entry `e`". The read
guard (`RG`) is the fact store. `RG` conflates read records and authorship
(`recordWritten`). The two differ on `/tree` (authorship is reset there,
#3603), on fork (the `read-guard-authorship` store resets,
`clients/read-guard-branch.ts`), and in the branch filter: only the
read-set passes through `importBranch`, while authorship restores unfiltered
(`clients/read-guard-branch.ts`). Beside it:

- the turn counter (`TC`);
- the widget's write-order guard (`WG`), which lives in a `clients/` module
  and so survives an entry-module re-evaluation and a factory re-run;
- the LSP fleet (`LS`), fenced by the LSP service generation, one process
  counter since #3755;
- the registry entry (`RE`) and its re-registration intent;
- the lazy-tool activations (`LZ`, #3604): origin scopes, with no entry and no
  branch filter (`lazyToolMemoryStore`, `clients/tool-set-policy.ts`);
- the agent advisory queue (`AD`, #3757): one advisory per producer, tagged
  with the scope that queued it (`queueAgentAdvisory`,
  `clients/agent-nudge.ts`).

**Scopes.** Each activation gets a scope: a ticket drawn from one process
counter (S1, `clients/session-scope.ts`), with a role (primary or
secondary), a session file and a branch epoch. A handle is current while its
scope is live and, at branch level, while its branch epoch is unchanged. That
is the only identity. The module-level `runtime` is modelled as `last`, the
scope the most recent primary `session_start` served.

**Host transitions** (pi 0.85.1):

| Transition | Modelled as |
|---|---|
| `/new`, resume, `/fork`, `/clone` | `session_shutdown`, then the new activation's `session_start`. Shutdown and start are separate steps, so a writer can land between them. `/fork` copies the branch without its last entry; `/clone` copies all of it. pi sends reason `fork` for `/clone`. `session_before_fork` is an action with no effect under the merged mechanisms (S2 deleted pi-lens' handler); it carries only the pre-S2 slot. |
| `/reload` | The same, on the same file. The start may re-evaluate the entry module (jiti fallback), which restarts a per-evaluation order turn (N3). |
| cancelled fork | Another extension cancels after `session_before_fork` (I3). |
| quit, `pi --fork` | Quit ends the process, and in-flight work dies with it. `pi --fork` then starts a new process whose only channel is the parent's sidecar. |
| `/tree` | The same activation. The branch loses its last entry and the scope's branch epoch bumps (`moveBranch`, from `retainBranch`). |
| LSP idle reset | pi-lens' own timer. It resets the LSP service only. |
| subagent start/stop | An in-process subagent binds with reason `startup` while the primary is live, or in its replacement gap, where #3668 declines it. It skips `handleSessionStart` (#473), begins its own scope (`beginScope` in the `session_start` handler, `index.ts`) and never adopts. |
| subagent `/reload`, `/fork`, `/new` | Its own replacement, in two steps: `SecDown` (its shutdown, the secondary path, no stash) and a later `SecUp` (its start), because pi awaits the shutdown's handlers before it builds the successor. The start may never come (pi's `reload()` emits no `session_start` to a session without host bindings). `/new` (`SecNew`) goes to file `U`; in memory, pi links it to nothing. In the primary's gap, #3668's rule made a non-`startup` start primary and the real successor was demoted (`BeginDemoted`, row 17). Under `namedSuccessor` (#3855) only the start whose (reason, key) the primary's shutdown named is primary. |
| duplicate start | A second `session_start` for the same replacement (I5, #2890). |
| interrupted start | `Interrupt` (#3881): the replacement's primary start begins (its scope's ticket is drawn, the module-level runtime serves it), and before `adoptHandoff` the activation's own `/reload` shutdown lands, because a handler ordered before pi-lens scheduled `AgentSession.reload()` and pi does not stop it while it awaits the start's emit. One step, once per behaviour. The start never adopts or registers, and the shutdown saves no sidecar (the coordinator's session id is not pinned yet, so `persistScope` does not run). Not combined with registry or LSP writers. |

**The hand-off (S2).** `stashHandoff` (`clients/session-scope.ts`)
replaces the one process slot at a primary shutdown whose successor reads it:
`/reload` (key: `reload` and the session's own file) and `/fork` or `/clone`
(key: `fork` and pi's `targetSessionFile`). `/new`, resume and quit leave the
slot as it is. A file-less session keys on `undefined`
(`clients/session-scope.ts`; the model's `FileLess` constant).
`takeHandoff` (`clients/session-scope.ts`) is called only by a primary
fork or reload start; it takes the slot on an equal key and leaves an
unmatched slot in place with no expiry (`clients/session-scope.ts`). A
start's source is fixed by its reason (`SOURCES`,
`clients/session-scope.ts`): a fork reads the slot, else the parent's
sidecar; a reload the slot, else its own sidecar; a resume and a launch their
own sidecar, else the parent's; `/new` nothing. The first source that exists
wins for every store (`adoptHandoff`, `clients/session-scope.ts`).

**The sidecar is abstracted.** The model saves a scope's sidecar at every
primary shutdown. The code saves it at `turn_end` and at a `/reload` or
`/fork` shutdown that left a slot (`persistScope` in the `session_shutdown` handler, `index.ts`). The two differ only for a
write that lands after the last `turn_end` and before a `/new`, resume or quit
shutdown: the `agent_settled` drain's authorship credit, which every start
but `/reload` resets anyway (`clients/read-guard-branch.ts`).

**Writers.** Each writer begins once in a live scope and lands at any later
step. pi refuses `/tree` and `/reload` while streaming, but `agent_settled`
handlers run after the run is marked inactive (I1), and bounded handlers are
abandoned without being cancelled (I2). This over-approximation hides nothing
the host allows.

- `read`: a primary read-guard write after an await: a late read producer or
  `recordWritten` in `handleToolResult` (`clients/runtime-tool-result.ts`),
  a bridge replay (`clients/mutation-bridge.ts`), or the `agent_settled`
  drain's credit. S3 fences them all by the handle captured at hook entry
  (`entryCapture`); without it, the write resolves the module-level runtime
  when it lands, as `recordWritten` did before S3. The native read record of a
  non-bash tool is not a late writer: `handleToolResult` does not await before
  it (#3732's premise check).
- `secRead`: the same in a subagent.
- `heartbeat`: the registry heartbeat's repair.
- `lsp`: LSP work that can spawn a server (#3576), fenced by
  `captureLspServiceGeneration` (`clients/lsp/server.ts`).
- `widget`: a pipeline verdict write to the widget in the current turn.
- `advisory`: the `agent_end` drain's lost-edit notice, tagged with the
  drain's captured scope (#3757).
- `activate`: `pi_lens_activate_tools` in a live scope (`rememberLazyTools`,
  `index.ts`), atomic.

A `Context` action is a context call of a live scope (`consumeAgentNudge`,
`clients/agent-nudge.ts`): under #3757 it prunes the retired scopes'
advisories, each with a counted record, and takes its own.

**Which entry a read-guard writer holds** is the constant `LateHandlers`.
With `FALSE`, the writer holds its branch's newest entry: the tool result its
handler is processing. With `TRUE`, it holds any entry of its branch, because
its handler outlived a later entry. Every config uses `TRUE` except
`NewestReadTreeFork`, `AcceptedLateReadReload` and `AcceptedLateReadResume`.

**Policies are constants.** A config picks `TargetPolicy` (the merged table)
or `LegacyPolicy` (master at df5fb8abb, before #3669 and S1-S3), `TargetFence`
or `LegacyFence`, and `TargetSec` (the design, S4 included), `MergedSec`
(merged master), `PreS4TurnSec` (merged master before #3613's turn half) or
`LegacySec`.

| Store | startup | /new | resume | /fork, /clone, pi --fork | /tree | /reload | shutdown | idle | Secondary: target / merged | Fence |
|---|---|---|---|---|---|---|---|---|---|---|
| `RG` target | rehydrate | reset | rehydrate | import-parent | filter-by-branch (D8) | filter-by-branch (D5) | none | none | own / shared (#3613) | branch |
| `RG` legacy | rehydrate | reset | rehydrate | reset | none | reset (N1) | none | none | shared | session |
| `TC` | reset | reset | reset | reset | none | reset | none | none | own / own (#3613; before it shared, N2) | session |
| `WG` guards | reset | reset | reset | carry (legacy: reset, #3589) | carry | carry | none | none | shared | none |
| `LS` | none | none | none | none | none | none | reset | reset | shared | service |
| `LT` lens toggles | reset | reset | reset | reset | none | reset | none | none | shared | none |
| `LZ` activations | rehydrate | reset | rehydrate | import-parent (legacy `pi --fork`: reset, #3604) | none (D7) | carry | none | none | own / own (legacy: shared, #3653) | none |
| `AD` advisories | none | none | none | none | none | carry (slot only; legacy: none) | none | none | per scope (#3757) | none |

- The code's `StartAction` is `adopt | reset | none`; which source an `adopt`
  reads is fixed by the reason, and only the read-set is branch-filtered. The
  model's `rehydrate`, `import-parent`, `carry` and `filter-by-branch` are the
  `adopt` rows of that table.
- `LT` carries no model state.

**`FixParts` selects the mechanisms:**

- `entryCapture` (S3, D2): writers use the lineage handle captured at hook
  entry.
- `handoffAtShutdown` (S2, D3): the slot is written at `session_shutdown`,
  keyed by (start reason, successor file). Without it, the slot is written at
  `session_before_fork`, as #3669 shipped it (`stashForkHandoff`, pre-S2).
- `consumeOnMatch` (S2, F2): only a primary fork or reload start takes the
  slot, and only on an equal key; an unmatched slot stays. Without it, every
  start takes the slot and discards it when unmatched (design section 3.4 as
  written).
- `processOrderTurn` (S1, N3): the write-order turn is a process counter
  (`nextOrderTurn` in `clients/session-scope.ts`, drawn by `RuntimeCoordinator.beginTurn`).
- `dedupe`: the #2890 duplicate-start gate.
- `recordDrop` (S1, F1): a dropped read-guard write whose entry is still on
  its conversation's branch leaves a record (`recordDroppedRead`,
  `clients/session-scope.ts`).
- `advisoryScope` (#3757): a context call takes only its own scope's
  advisories, and a retired scope's are dropped with a record.
- `ticketKey` (#3819, option b): a file-less slot is keyed by the ticket of
  the scope that left it, bound to the session manager it left from
  (`stashHandoff`), and a start's key is the ticket bound to the manager pi
  hands it (`Carrier`). pi keeps the manager on `/reload` and on an
  in-memory `/fork`. Without it, a file-less key is `undefined`.
- `demotedDiscard` (#3819 r2): a demoted start (`BeginDemoted`) whose key
  matches the slot discards it without adopting (`discardHandoff`). No
  other start removes a slot except by taking it. Without it, the slot
  stays until a later start of the demoted session takes it.
- `forwardUnadopted` (#3881): the interrupted start's shutdown
  (`Interrupt`) re-keys the slot left for that start to its own `/reload`,
  written by the interrupted scope (`forwardHandoff`), and stashes nothing
  of the scope. Without it, it stashes the scope's empty snapshot, as
  `stashHandoff` did.
- `forwardUnstarted` (#4113, #3898's T-1): `InterruptAt("unstarted")` is a
  reload that lands before pi-lens's start handler ran (W0), so the
  activation has no in-flight mark and no scope; its shutdown is primary by
  the gap's named key (#4106). With this part it forwards the slot left for
  the start the gap names, as `forwardUnadopted` does (`namedSuccessorReason`,
  `clients/session-lifecycle.ts`); without it nothing is written, the slot
  keeps the `/fork` reason, and the inner reload's start misses it
  (`Mut4113Unstarted`). With the part, the W0 step reaches the same states as
  the W1/W2 step, so `H3InterruptedUnstarted` has `H3Interrupted`'s count.
- `forwardPolicy` (#3881 r2): the forwarded slot keeps only the stores the
  interrupted start's own reason adopts (`Keeps`), so the successor's
  policy applies on top of the original one. Without it, every store is
  forwarded, and the inner `/reload`'s start carries a `/fork` start's
  advisory (AD: fork none, reload carry).
- `namedSuccessor` (#3855, merged): a primary replacement shutdown names its
  successor by (reason, key) (`pend.key`, `NamedKey`; `successorStartKey` in
  `clients/session-scope.ts`). The key is the successor's file, else, for a
  `/reload` or in-memory `/fork`, the primary's ticket bound to the manager pi
  hands that successor, else none (an in-memory `/new`). In the gap a `SecUp`
  is primary only when its own (reason, key) equals that pair; a subagent's
  start carries its own file or, file-less, no key. `Begin`, the real
  successor, computes its own key from its side (`BeginKey`: its file, else
  the ticket bound to the manager pi hands it, `Via`) and is declined
  (`BeginDeclined`) when it is not the named one, so `HasPrimary` catches a
  drift between what a shutdown names and what its successor computes
  (#3855 verify r2 V2). `SecBind` is an SDK subagent's first bind with a
  replacement reason (verify r2 PR8).
- `rolelessKey` (#4106, V7 of #3855): `SecRoleless` is a gap subagent's own
  `/new` whose start its own `/reload` interrupts before pi-lens's start
  handler runs, so that activation shuts down with no recorded role while no
  primary is registered. Without this part it fails safe to primary, names
  the gap by a ticket on its own manager, and its reload successor takes the
  primary slot (`Mut4106RolelessShutdown`). With it, such a shutdown is the
  primary's only when its own key is the named one (`noteSessionShutdown`,
  `clients/session-lifecycle.ts`); a key of none against a name of none, the
  primary's in-memory `/new` gap, is residual R3 (`AcceptedR3RolelessNewGap`).
- `nameAtShutdown` (#3855 round 5, merged; verify r4 V6): the naming site
  (`successorStartKey`) binds a fresh process-unique ticket to a file-less
  `reload`/`fork` session's manager that carries none, in every window of an
  interrupted start. `InterruptAt(w)` models the windows: `"pre"` is a reload
  that lands before the start held its scope (inside pi-lens's start
  handler's awaits before `scope = runtime.sessionScope`), and `"unstarted"`
  one before that handler ran (#4113); both are in `preScope`,
  where only this rule binds. `Mut3855r4PreScope` keeps round 4's rule, which
  needs the scope and names such a gap `(reload, none)`.
- `bindInterrupted` (#3855 round 4, superseded by `nameAtShutdown`): a primary shutdown that
  forwards (`Interrupt`, #3881) binds the interrupted scope's ticket when its
  manager carries none. `Interrupt` names the gap by the key the code reads
  after the forward: the ticket on the interrupted start's manager, which is
  its predecessor's when that start kept the manager (`SameMgr`), else, with
  this part, its own, else none. `Carrier` follows a forwarded scope (`fwd`)
  to that binding, and a slot's ticket key is `slot.tk`, kept by a forward,
  apart from its writer `slot.from`. Without it, an interrupted in-memory
  `/new` names its reload gap `(reload, none)` and a key-less start takes it
  (`Mut3855r3InterruptedNewGap`).
- `keylessFailSafe` (#3855 round 2's J6, rejected in round 3): a key-less gap
  start with the named reason passes for a ticket name. It existed for a
  test double that minted a session manager per ctx; in pi it admits PR8's
  SDK subagent (`Mut3855r2KeylessFailSafe`).
- `inheritRole` (#3855 round 1, superseded): a secondary's `SecDown` leaves
  a note keyed by its successor's key (file-less: its ticket, bound to its
  manager), and a gap start whose note is still there stays secondary. An
  in-memory `/new` leaves no note (R1), `Evict` drops a note (the cap, under
  notes from subagents the model does not have), and a note whose start never
  comes stays; a primary successor whose key a note holds is declined
  (`BeginDeclined`). `Mut3855r1*` keep its violations.

`startThrows` and `pinAtReset` (#3613 F1, review r1 on #4118) are a fault
and its fix, not a merged mechanism pair. `startThrows` makes every primary
start's handler throw after its reset. The code then never pins the stable
session id if the pin sits after the start's await, and the coordinator
keeps the reset's random id. `pinAtReset` is the merged pin, placed before
the await (`index.ts`). `OwnTurn` selects a turn's target by id equality,
as `beginTurn` does (`turnSession`, `clients/runtime-coordinator.ts`): a
turn is the coordinator's own only when its session's id is the pinned
one.

## Invariants

| Invariant | Meaning |
|---|---|
| `NoCrossSessionState` | A live scope's read-guard cell holds only its own facts and the facts it inherited. The registry entry holds only live roots. Every LSP server belongs to the current service generation. |
| `NoStaleBranchWrite` | A live scope's own-lineage facts name entries on its current branch. |
| `NoLostCarry` | Every fact that reached a cell in the live scope's conversation lineage, on an entry that conversation still holds, is in the cell the scope reads. |
| `NoFalseBlock` | The same, over every read-guard write that completed, whether it landed or a guard dropped it. The design violates it (F1, accepted), so only `AcceptedLateRead*` and `NewestReadTreeFork` check it. |
| `NoUnrecordedFalseBlock` | `NoFalseBlock` over the writes that left no drop record: every false block is recorded. |
| `NoOwnDrop` | No guard drops a write whose own lineage is still current (catalog shape 54). |
| `SecondaryIsolation` | A primary transition never removes a live subagent's own facts, and every live scope's turn state is moved by its own turns only: a subagent's turn never moves the primary's, and the primary's turns and replacements never move or reset a live subagent's (#3613). |
| `HandoffOnce` | Every slot take is by a primary start that replaced the scope that wrote the slot. |
| `NoCrossSessionAdoption` | Every slot take is by a start whose conversation continues the writer's (the same file on `/reload`, a copy on `/fork`), so no start adopts another session's state through the slot (#3803 hypothesis 3). |
| `OrderMonotone` | A write-order token drawn later outranks every earlier one, across `/reload` and entry-module evaluations. |
| `OneResetPerScope` | One `session_start` mutation pass per scope. |
| `NoForeignFact` | A live scope's cell holds only facts of its own conversation lineage, on its current branch. |
| `NoForeignActivation` | A live scope holds only activations of its own conversation lineage. |
| `NoLostActivation` | A live scope of a primary's conversation, primary or secondary (a demoted real successor is a secondary), holds every activation the conversation made (`/tree` keeps them, D7). |
| `SecondaryKeepsActivation` | The same over the subagent's own conversations (files `S`, `T`). The merged design accepts its violation (F6). |
| `NoCrossSessionDelivery` | An advisory reaches only a context call of its own conversation lineage. |
| `NoLostAdvisory` | An advisory still queued when its scope retired by `/reload` is queued again once the successor started. One queued after its scope retired is an accepted, recorded drop. |
| `HasPrimary` | Whenever no primary replacement is pending, a scope holds the primary slot (#3855 F3: a declined real successor left none). |
| `PrimaryIsUsers` | No scope of the subagent's chain (`subBorn`, a ghost) holds the primary slot (#3855 F1: a gap start the primary did not name took it). |
| `UserNotDeclined` | A user conversation's own replacement start is never declined while no scope holds the primary slot (#3855 F2: round 1's notes declined it after an R1 demotion). |
| `AdvisoryStaysInSession` | An advisory reaches only a context call on its producer's session file. Only `/reload` carries an advisory, and `/reload` keeps the file, so a delivery across files crossed a `/fork`, `/clone` or resume (#3881 r2). Checked by the `Interrupt` configs. |

The conversation lineage the invariants check is per file (`lin`), and
`/fork`, `/clone` and `pi --fork` copy it. It is the truth, and it is
independent of the policy under test, so a `reset` policy cannot hide the loss
it causes.

## Bounds

A pass holds only inside these bounds:

- **Each transition kind happens at most once per behaviour**, and at most
  `MaxSteps` transitions happen (3 in `Fix`, `Merged` and `MergedStores`).
- **One `/new` target.** `/new` always creates file `N`, which is why the
  once-per-kind bound is load-bearing for `/new`: a second `/new` onto the
  same file `N` would be a model artifact, not host behaviour.
- **`/tree` only on a two-entry branch**, and it drops the last entry.
- **One writer of each kind** begins per behaviour, one advisory per producer,
  and one activation per scope. `MaxTurns` is 0 in `Merged`, 1 in `Fix` and
  `Current`, 2 in `MergedTurns`, and 3 in `FixOrder`.
- **One subagent** (file `S`, its fork `T`), no time, and tool-call ids unique
  across conversations (D4 is not modelled).

## Results

TLC 2.19 (`tla2tools.jar` v1.7.4), one TLC worker per config, through
`node scripts/check-tla-models.mjs`. A violated config stops at its first
counterexample.

| Config | Models | Expect | States |
|---|---|---|---|
| `Merged` | merged master: every transition but a subagent's turn and its own replacement, the primary's read-guard writer | pass | 11116 |
| `MergedStores` | merged master: activations and advisories across every transition that moves them, with a subagent | pass | 65248 |
| `MergedTurns` | merged master with turns (#3613): a subagent's turns and the primary's turns, `/new`, resume, `/fork`, `/reload` and `/tree`, the primary's read-guard writer | pass | 23024 |
| `H3StartThrows` | #3613 F1 fix: `MergedTurns` with every start throwing after its reset, and the pin before the await | pass | 23024 |
| `H3FileBacked` | merged slot: a subagent's own `/reload` or `/fork` in the primary's gap, file-backed sessions | pass | 597 |
| `H3FileLess` | the same, file-less sessions, with #3819's fix | pass | 597 |
| `H3FileLessStores` | `H3FileLess` with activations and advisories: none crosses | pass | 20834 |
| `H3FileLessCarry` | #3819's ticket key still carries a file-less `/reload`'s activations and advisory while a subagent binds in the gap | pass | 278 |
| `H3StaleSlot` | file-backed, five transitions with `/new` and resume: the demoted successor discards its slot, so the demoted session's later `/reload` takes nothing, with #3819's fix | pass | 3016 |
| `H3StaleSlotFileLess` | the same, file-less sessions | pass | 3016 |
| `H3Interrupted` | file-backed: a `/reload`, `/fork` or resume start is interrupted by its own `/reload` before it adopts, with #3881's fix: the inner reload's start keeps the reads, activations and advisory, and an interrupted `/fork` carries no advisory | pass | 226398 |
| `H3InterruptedFileLess` | the same, file-less sessions | pass | 226398 |
| `H3InterruptedUnstarted` | #4113: the same, and the reload may also land before pi-lens's start handler ran (W0): that shutdown forwards the slot left for the start its gap names | pass | 226398 |
| `H3InterruptedUnstartedFileLess` | the same, file-less sessions | pass | 226398 |
| `H3DemoteCarry` | file-backed, #3855's fix: a subagent's own `/reload` or `/fork` in the gap stays secondary, so the real successor keeps the reads | pass | 235 |
| `H3DemoteAdvisory` | the same: the real successor keeps the advisory | pass | 224 |
| `H3DemoteActivation` | the same: the real successor keeps the conversation's activations | pass | 256 |
| `H3DemoteFileLess` | the same with file-less sessions: reads, advisory, activations, and no foreign or second slot take | pass | 21218 |
| `AcceptedSecondaryForkActivation` | F6: a subagent's own `/fork` or `/reload` starts without its activations (a secondary never adopts) | violated `SecondaryKeepsActivation` | 23 |
| `H3SecNew` | #3855 r2, review F1: a subagent's own in-memory `/new` in the `/reload` gap stays secondary; the real successor keeps reads, activations and advisory | pass | 11510 |
| `H3SecNewFileLess` | the same, file-less sessions | pass | 11510 |
| `H3DemotedReplaces` | #3855 r2, review F2: no demotion, so the user's conversation is never declined replacing itself | pass | 246 |
| `H3StaleNoteResume` | #3855 r2, review F3: a subagent reload whose start never comes, then the primary resumes its file: the process keeps a primary | pass | 9 |
| `H3NoteEvicted` | #3855 r2: nothing to evict; a gap subagent's own `/reload` is declined by the pair | pass | 136 |
| `H3InMemoryNewGapReload` | #3855 r2, row 12: in an in-memory `/new` gap a key-less subagent `/reload` is told apart by its reason | pass | 16 |
| `H3InterruptedNewGap` | #3855 r4, verify r3 V3 (PR12): an in-memory `/new` interrupted by its own `/reload`; a gap subagent's own in-memory `/reload` or an SDK reload bind stays secondary | pass | 500 |
| `Mut3855r3InterruptedNewGap` | #3855 r3, code-faithful `Interrupt` without a binding rule: the key-less start takes the slot | violated `PrimaryIsUsers` | 17 |
| `H3RolelessShutdown` | #4106: the gap subagent's role-less `/new` shutdown keeps the secondary role in the primary's `/reload`, `/fork` or file-backed `/new` gap | pass | 4462 |
| `Mut4106RolelessShutdown` | pre-#4106: the role-less shutdown fails safe to primary and its successor takes the slot | violated `PrimaryIsUsers` | 75 |
| `AcceptedR3RolelessNewGap` | #4106 residual R3: the same in the primary's in-memory `/new` gap | violated `PrimaryIsUsers` | 28 |
| `Mut3855r4PreScope` | #3855 r4, the forward-path bind, with a reload that lands before the start held its scope (verify r4 V6) | violated `PrimaryIsUsers` | 19 |
| `H3SdkBind` | #3855 r3, verify r2 PR8: an SDK subagent's in-memory first bind with reason `reload`/`fork` in an in-memory primary's gap stays secondary; the real successor keeps its activations | pass | 236 |
| `H3SdkBindFileBacked` | the same, file-backed | pass | 236 |
| `Mut3855r2KeylessFailSafe` | #3855 r2's J6: the SDK subagent takes the primary slot | violated `PrimaryIsUsers` | 11 |
| `Pre3855SdkBind` | pre-#3855 (#3668 row 17): the same | violated `PrimaryIsUsers` | 10 |
| `AcceptedR3InMemoryNew` | F7, residual R3: a subagent's own in-memory `/new` in the primary's in-memory `/new` gap is primary first | violated `PrimaryIsUsers` | 13 |
| `Mut3855r1SecNew` | #3855 r1 (R1): a subagent's own in-memory `/new` leaves no note and takes the primary slot | violated `PrimaryIsUsers` | 103 |
| `Mut3855r1DemotedReplaces` | #3855 r1 (F2): the demoted user conversation's own `/reload` finds its note and is declined | violated `UserNotDeclined` | 212 |
| `Mut3855r1StaleNote` | #3855 r1 (F3): a stale note declines the primary's resume successor; no primary | violated `HasPrimary` | 6 |
| `Mut3855r1Evicted` | #3855 r1: an evicted note lets a gap subagent's start demote the real successor | violated `NoLostCarry` | 225 |
| `Current` | merged master, every transition: F4, #3613 | violated `NoCrossSessionState` | 257 |
| `Fix` | adopted design: every transition, a primary and a subagent reader, one turn | pass | 71419 |
| `FixProcess` | adopted design: heartbeat and LSP work across `/new`, resume, `/reload`, idle reset, quit, `pi --fork` | pass | 24771 |
| `FixOrder` | adopted design: widget tokens over three turns across `/new`, `/reload`, quit, `pi --fork` | pass | 319 |
| `NewestReadTreeFork` | F1 bound: a reader of the newest entry across `/tree` and `/fork` | pass | 42 |
| `AcceptedLateReadTree` | F1 on `/tree`, a handler that outlived a later entry | violated `NoFalseBlock` | 11 |
| `AcceptedLateReadFork` | F1 on `/fork`, a handler that outlived a later entry | violated `NoFalseBlock` | 23 |
| `AcceptedLateReadReload` | F1 on `/reload`, a reader of the newest entry | violated `NoFalseBlock` | 12 |
| `AcceptedLateReadResume` | F1 on `/new`, then resume, a reader of the newest entry | violated `NoFalseBlock` | 28 |
| `PreS1OrderTurn` | pre-S1: a re-evaluation restarts the order turn | violated `OrderMonotone` | 19 |
| `MutWidgetDropAfterReEval` | pre-S1: the widget guard drops the live verdict | violated `NoOwnDrop` | 70 |
| `PreS2ReloadReset` | pre-S2: `/reload` resets the read guard | violated `NoLostCarry` | 21 |
| `PreS2SnapshotAtBeforeFork` | pre-S2: the fork slot is filled at `session_before_fork` | violated `NoLostCarry` | 28 |
| `PreS2Activations` | pre-S2: `pi --fork` starts without the parent's activations | violated `NoLostActivation` | 7 |
| `PreS2SecondaryActivations` | pre-S2: a subagent's activation lands in the primary's memory | violated `NoForeignActivation` | 5 |
| `PreS2AdvisoryReload` | pre-S2: `/reload` loses a queued advisory | violated `NoLostAdvisory` | 18 |
| `PreS3StalePipelineAfterNew` | pre-S3: `recordWritten` lands after `/new` | violated `NoCrossSessionState` | 18 |
| `Pre3757AdvisoryShared` | pre-#3757: a subagent's context call takes the primary's advisory | violated `NoCrossSessionDelivery` | 9 |
| `Pre3819FileLess` | pre-#3819: a subagent's own replacement takes a file-less primary's slot | violated `NoCrossSessionAdoption` | 63 |
| `Pre3819StaleSlot` | pre-#3819: a demoted session takes a stale slot | violated `HandoffOnce` | 1177 |
| `Pre3881Interrupted` | pre-#3881: the interrupted start's shutdown stashes its empty scope | violated `NoLostActivation` | 209 |
| `Mut4113Unstarted` | pre-#4113: a W0 shutdown writes nothing, so the `/fork` slot is missed | violated `NoLostActivation` | 478 |
| `Pre3855DemoteCarry` | pre-#3855, #3668 row 17: the demoted real successor loses the reads | violated `NoLostCarry` | 239 |
| `Pre3855DemoteAdvisory` | pre-#3855: the demoted real successor loses the advisory | violated `NoLostAdvisory` | 236 |
| `Pre3855DemoteActivation` | pre-#3855: the demoted real successor loses the conversation's activations | violated `NoLostActivation` | 145 |
| `MutInterruptedForkPolicy` | #3881 r1: the forward keeps every store, so an interrupted `/fork` is adopted under the `/reload` policy | violated `AdvisoryStaysInSession` | 3412 |
| `MutFileLessNoTicketKey` | #3819's fix without `ticketKey` | violated `NoCrossSessionAdoption` | 63 |
| `MutStaleSlotNoDiscard` | #3819's fix without `demotedDiscard` | violated `HandoffOnce` | 1177 |
| `MutForkClosureStash` | pre-#3669: the fork stash is per activation | violated `NoLostCarry` | 24 |
| `MutTreeCarries` | pre-#3669: no `session_tree` handler | violated `NoStaleBranchWrite` | 14 |
| `MutSettleDuringTree` | the drain writer races `/tree`, fenced at session level only | violated `NoStaleBranchWrite` | 12 |
| `MutLspAfterIdleReset` | LSP work spawns after the idle reset | violated `NoCrossSessionState` | 8 |
| `MutHeartbeatBeforeRegistration` | a heartbeat lands before the new registration | violated `NoCrossSessionState` | 10 |
| `MutSecondaryTurnStart` | pre-#3613: a subagent's `turn_start` advances the primary's turn | violated `SecondaryIsolation` | 4 |
| `MutSecondaryTurnReset` | pre-#3613: the primary's turn start or `/new` moves a live subagent's per-turn records | violated `SecondaryIsolation` | 8 |
| `MutStartThrowsLatePin` | #3613 r1 (F1): the throwing start with the pin after the await; the primary's turns never move its turn state | violated `SecondaryIsolation` | 7 |
| `MutTreeWipesSecondary` | the primary's `/tree` filters the subagent's reads | violated `SecondaryIsolation` | 9 |
| `MutSecondaryReadShared` | a subagent's read lands in the primary's read guard | violated `NoCrossSessionState` | 4 |
| `MutSecondaryTakesHandoff` | a subagent's start takes the slot and discards it | violated `HandoffOnce` | 7 |
| `MutDuplicateStart` | no #2890 gate | violated `OneResetPerScope` | 2 |

## Pre-fix and Mut configs and their issues

Provenance: "master" is today's code (open, or an accepted residual);
"pre-X" is code before fix X landed, named by the commit it models; "design
alternative" is a shape the adopted design rejects, never shipped.

| Config | Issue | Provenance | Shortest counterexample |
|---|---|---|---|
| `Pre3819FileLess` | #3819 | pre-#3819 (560f24ff5): the file-less key `(reason, undefined)` (`clients/session-scope.ts`) and #3668's row 17 (`clients/session-lifecycle.ts`: with no primary registered, only a `startup` start is declined) | The primary's `/reload` shutdown stashes `(reload, undefined)`; a subagent starts in the gap and is declined; the subagent's own `/reload` start classifies primary and takes the primary's slot. `/fork` fails the same way. |
| `Pre3819StaleSlot` | #3819 (review S1 on #3835) | pre-#3819 (560f24ff5): `stashHandoff` returns early for `/new` and resume (their `SOURCES` hold no slot), so the slot survives them, and `takeHandoff` has no expiry | The primary's `/reload` stashes `(reload, A)`; a subagent starts and is declined; the subagent's own `/fork` classifies primary (row 17) and does not match; the real successor is demoted; the new primary's `/new` (or resume) keeps the slot; the demoted session's own `/reload` classifies primary and takes scope 1's slot. Same conversation, so `NoCrossSessionAdoption` holds. |
| `Pre3855DemoteCarry` | #3855 (#3668 row 17) | pre-#3855 (b9eda404c): `decideSessionStart` in `clients/session-lifecycle.ts` declined only `startup` starts in the gap | A read lands; the primary's `/reload`; a subagent's own `/reload` or `/fork` classifies primary; the real successor is demoted and adopts nothing. |
| `Pre3855DemoteAdvisory` | #3855 (#3668 row 17) | pre-#3855 (b9eda404c), as `Pre3855DemoteCarry` | An advisory is queued; `/reload`; row 17 demotes the real successor; a context call prunes the advisory as its retired scope's. |
| `Pre3855DemoteActivation` | #3855 (#3668 row 17) | pre-#3855 (b9eda404c), as `Pre3855DemoteCarry` | The primary activates a tool; `/reload`; row 17 demotes the real successor, which never adopts the primary's activations. |
| `Mut3855r1SecNew` | #3855 review F1 | #3855 r1 (6ae7e2716): `noteSecondaryReplacement` left no note for an in-memory `/new` | `/reload`; a subagent binds and runs an in-memory `/new`; its start finds no note and classifies primary. |
| `Mut3855r1DemotedReplaces` | #3855 review F2 | #3855 r1 (6ae7e2716): every secondary-role activation left a note, the demoted real successor's too | The primary's `/new`; R1 makes the subagent's `/new` primary and demotes the real successor; the subagent primary reloads; the demoted conversation reloads in that gap, finds its own note and is declined. |
| `Mut3855r1StaleNote` | #3855 review F3 | #3855 r1 (6ae7e2716): notes had no time bound | A subagent reloads and its start never comes; the primary resumes the subagent's file; its successor matches the stale note and is declined. |
| `Mut3855r1Evicted` | #3855 r1 | #3855 r1 (6ae7e2716): `SECONDARY_SUCCESSOR_NOTE_CAP` | A read lands; `/reload`; the gap subagent's note is evicted; its own `/reload` start classifies primary and the real successor is demoted. |
| `Mut4106RolelessShutdown` | #4106 | pre-#4106 (8d030fa27): `noteSessionShutdown` returned primary whenever no primary was registered | The primary's `/reload`; a subagent binds and runs a `/new`; its start is interrupted by its own `/reload` before pi-lens's handler (`SecRoleless`); the role-less shutdown is primary and its reload successor takes the slot. |
| `Mut3855r4PreScope` | #3855 verify r4 V6 | #3855 r4 (0b8ee3ca4): `forwardHandoff` bound the interrupted scope's ticket, which a start interrupted before `scope = runtime.sessionScope` does not hold | The primary's in-memory `/new`; a `/reload` lands before its start held its scope (`InterruptAt("pre")`); an SDK reload bind (no key) takes the slot. |
| `Mut3855r3InterruptedNewGap` | #3855 verify r3 V3 | #3855 r3 (53ef06147): `forwardHandoff` bound no ticket | The primary's in-memory `/new`; its start is interrupted by its own `/reload`; an SDK subagent binds with reason `reload` and no key; the gap was named `(reload, none)`, so it is primary. |
| `Mut3855r2KeylessFailSafe` | #3855 verify r2 V1 | #3855 r2 (317ffae8a): J6's `key === undefined && typeof namedKey === "number"` | An in-memory primary's `/reload` or `/fork`; an SDK subagent binds with that reason and no key; J6 admits it and the real successor is demoted. |
| `Pre3855SdkBind` | #3855 verify r2 PR8 | pre-#3855 (b9eda404c): #3668 row 17 | As above, with any non-`startup` gap start admitted. |
| `AcceptedR3InMemoryNew` | #3855 residual R3 | master, accepted | The primary's in-memory `/new`; a subagent's own in-memory `/new` starts first in the gap with the same pair. |
| `AcceptedSecondaryForkActivation` | #3855 (the #3835 r2 question) | master, accepted: a secondary's scope never stashes, saves a sidecar or adopts, and `adoptHandoff` runs only for a primary start | The subagent activates a tool, and its own `/fork` starts without it. |
| `Current` | F4, #3613 | master: a subagent's handlers reach the module-level `runtime.readGuard` | The subagent's read lands in the primary's cell. |
| `PreS1OrderTurn` | N3; #3540 case A | pre-S1 (b456ff89c): `_writeOrderTurn += 1`, a coordinator field | A turn draws token 1, `/reload` re-evaluates the entry, and the next turn draws token 1 again. |
| `MutWidgetDropAfterReEval` | N3's harm; #3540 | pre-S1 (b456ff89c), as above | Two turns and a widget write at token 2; after `/reload` with re-evaluation, a turn draws token 1, and the widget guard drops the live session's own write as older. |
| `PreS2ReloadReset` | N1, under D5 | pre-S2 (ae5396e46): `resetForSession` on every primary start, no reload hand-off | A read lands, and `/reload` starts clean. |
| `PreS2SnapshotAtBeforeFork` | the D3 check; #3521 fork half | pre-S2 (ae5396e46): #3669's `stashForkHandoff` in the `session_before_fork` handler | `session_before_fork` fills the slot, a read lands, then shutdown and start: the fork lacks the read. |
| `PreS2Activations` | #3604 | pre-S2 (ae5396e46): `rememberedLazyToolsBySessionFile`, an in-process map | An activation, quit, `pi --fork`: the child has none. |
| `PreS2SecondaryActivations` | #3653 | pre-S2 (ae5396e46): one process-wide activation memory | The subagent activates a tool, and the primary's memory holds it. |
| `PreS2AdvisoryReload` | #3612 (the advisory scope addition) | pre-S2 (ae5396e46, which has #3757): no advisory store | An advisory is queued, `/reload`, and the prune drops it as its retired scope's. |
| `PreS3StalePipelineAfterNew` | #3596; the #3528 drain shape | pre-S3 (f8453c664): `runtime.readGuard.recordWritten` resolved when the write lands | A write begins, `/new` completes, and the write lands in session 2. |
| `Pre3757AdvisoryShared` | #3748 | pre-#3757 (61c6ee644): an untagged queue | The drain queues an advisory, and the subagent's context call takes it. |
| `Mut4113Unstarted` | #4113 | pre-#4113 (17b10c027): the shutdown forwarded only under the in-flight mark, which a start interrupted before pi-lens's handler ran never set | An activation lands; `/fork` leaves the `(fork, key)` slot; the fork's start is interrupted by its own `/reload` before pi-lens's handler (`InterruptAt("unstarted")`); nothing is forwarded, and the inner reload's start misses the slot. |
| `Pre3881Interrupted` | #3881 | pre-#3881 (5d55e4821): `stashHandoff` at every primary `/reload` shutdown, whether or not the activation's start adopted | An activation lands; `/reload` (or `/fork`) leaves the slot; the successor's start is interrupted by its own `/reload`, whose shutdown stashes the empty scope over that slot; the inner reload's start takes the empty slot. |
| `MutInterruptedForkPolicy` | #3881 (review r1 F1 on #3898) | #3881 r1 (cbcd95b94): `forwardHandoff` re-keyed the whole slot | An advisory is queued; `/fork` leaves the slot; the fork's start is interrupted by its own `/reload`, which forwards every store; the inner reload's start re-tags the parent's advisory, and a context call on the fork's file delivers it. |
| `MutFileLessNoTicketKey` | #3819 | design alternative: the discard alone | As `Pre3819FileLess`: the subagent's own start classifies primary before the real successor starts, so it matches `(reason, undefined)`. |
| `MutStaleSlotNoDiscard` | #3819 | design alternative: option (b) alone | As `Pre3819StaleSlot`: the demoted session inherits the primary's session manager on `/reload`, so its ticket key matches the stale slot. |
| `MutForkClosureStash` | #3521 fork half; the #3589 shape | pre-#3669 (df5fb8abb): `pendingForkReadGuard`, an activation-closure `let` | A read lands, then `/fork`: the fork starts clean. |
| `MutTreeCarries` | #3521 tree half | pre-#3669 (df5fb8abb): no `session_tree` handler | A read of entry 2 lands, then `/tree` drops entry 2 and the read stays. |
| `MutLspAfterIdleReset` | #3576 | pre-#3602 (7101a6766): before G5's `captureLspServiceGeneration` | LSP work begins, the idle reset runs, and the work spawns a server. |
| `MutHeartbeatBeforeRegistration` | #3498 | pre-#3593 (f2c880012): the heartbeat before #3498's fix; the lock-level detail is `formal/session-registry` | A heartbeat begins, session 1 shuts down, and the heartbeat re-registers session 1's root before session 2's registration lands. |
| `MutSecondaryTurnStart` | N2, #3613 | pre-#3613 (17b10c027): `onTurnStart` called `runtime.beginTurn()` with no session id (`index.ts`) | The subagent starts, and its `turn_start` moves the primary's turn. |
| `MutSecondaryTurnReset` | #3613 | pre-#3613 (17b10c027): one per-turn warning map on the coordinator, cleared by every `beginTurn` and by `resetForSession` | The primary's turn starts while a subagent is live, so the subagent's per-turn records move (the same for the primary's `/new`). |
| `MutStartThrowsLatePin` | #3613 F1 (review r1 on #4118) | #4118 r1 (c4c4564b6): `setSessionLifecycle` after `await bounded(handleSessionStart …)` | The startup's handler throws after its reset, the pin is skipped, and the primary's first turn takes the other-session path. |
| `MutSecondaryReadShared` | F4, #3613 | master: a subagent's handlers reach the module-level `runtime.readGuard` | The subagent's read lands in the primary's cell. |
| `MutTreeWipesSecondary` | #3607 | master, the accepted residual #3521 F2 (the comment on the `session_tree` handler, `index.ts`) | The subagent's read lands, and the primary's `/tree` filters it away. |
| `MutSettleDuringTree` | #3521 (the G10 F1 review race) | design alternative: fenced at session level with no branch epoch | A read of entry 2 begins, `/tree` drops entry 2, and the read lands. |
| `MutSecondaryTakesHandoff` | design finding F2 | design alternative: section 3.4 as written | `/reload`'s shutdown fills the slot, and a subagent's `session_start` takes it. |
| `MutDuplicateStart` | #2890 | pre-#2895 (745020083): no duplicate-start gate | A duplicate start re-runs the reset. |

Since #3613's turn half, `Current` holds `SecondaryIsolation` and violates
`NoCrossSessionState` (257 states): F4, the read-guard half of #3613, still
open. `MergedTurns` checked under `PreS4TurnSec` violates
`SecondaryIsolation` (26 states), and `MutSecondaryTurnReset` passes under
the invariant before #3613 (19 states): the turn clause for live subagents
is what sees the primary's turn and reset moving their records.

## Findings

**F1. A dropped late read is a false block, and the design accepts it.** A
write whose handle is not current is dropped, and when the live conversation
still holds the dropped write's tool result, the next edit of that file is a
false block. `/reload` and resume are the exposure for a handler still
processing the newest tool result (`AcceptedLateReadReload`,
`AcceptedLateReadResume`). `/tree` and `/fork` lose a read only when its
handler outlived a later entry (`AcceptedLateReadTree`,
`AcceptedLateReadFork`; `NewestReadTreeFork` passes). Decision (2026-09-30,
A + C): the drop stays and leaves one bounded record with the retirement
reason (`recordDrop`, `recordDroppedRead`), checked by
`NoUnrecordedFalseBlock`. The late writers are the ones S3 fenced; the native
read record of a non-bash tool is not late (#3732's premise check).

**F2. A subagent's start must not consume the hand-off.** Design section 3.4
had every start take the slot and discard it when unmatched
(`MutSecondaryTakesHandoff`). Decision (2026-09-30): consume only on a match
and leave an unmatched slot (`consumeOnMatch`). In the code a subagent's
start never calls `takeHandoff` at all.

**F3. #3668's row 17 opens the slot to the wrong start (#3819).** A
subagent's own `/reload` or `/fork` in the primary's replacement gap
classifies primary. Three consequences follow.

- *Cross-session adoption, file-less only.* With the code's key, that start
  cannot take a file-backed primary's slot, because the files differ
  (`H3FileBacked` passes; making `SlotMatch` ignore the file reds it). A
  file-less session keys on `undefined`, so it takes the primary's slot
  (`H3FileLess`). The branch filter keeps foreign reads out (`NoForeignFact`
  holds, since tool-call ids differ), but activations and advisories cross,
  and authorship restores without the filter. A file-less primary's own
  chain of transitions stays safe: each fork or reload start is preceded by
  its own shutdown's stash. For adoption across sessions it does not matter
  whether `Begin` keeps an unmatched slot or whether `/new` clears it: the
  take happens in the gap, before the real successor starts.
- *A stale take, file-backed too.* The unmatched slot is not harmless.
  After row 17 demotes the real successor, `/new` keeps the slot, and the
  demoted session's own `/reload` later takes its predecessor's stale
  snapshot (`H3StaleSlot`, `HandoffOnce`). Clearing the slot at `/new`
  alone leaves the same path through the new primary's resume, while
  clearing it at every primary start after the take attempt (the audit's
  option (a)) closes it: `H3StaleSlot` passes (2322 states in the #3835 r1
  review). Keying a file-less slot by ticket alone does not close it (the
  #3835 review ran #3819's ticket-key model at five steps). So "file-backed sessions are protected" holds for
  adoption across sessions only. #3819's fix pairs the ticket key with
  `demotedDiscard` rather than option (a): (a) also destroys a legitimate
  slot when a row-17 gap primary quits inside the gap, so the real successor
  classifies primary and finds nothing (the #3868 r1 review's F1). The
  model cannot reach that cell, because it has one `pend`; a runtime witness
  pins it.
- *Loss.* The demoted real successor adopted nothing, so the conversation
  lost its reads, its queued advisory and its activations
  (`Pre3855DemoteCarry`, `Pre3855DemoteAdvisory`,
  `Pre3855DemoteActivation`), whether sessions have files or not. #3855
  closes it with `namedSuccessor` (`H3DemoteCarry`, `H3DemoteAdvisory`,
  `H3DemoteActivation`, `H3DemoteFileLess`; F7).

The `H3FileBacked`, `H3FileLess*`, `H3StaleSlot*`, `Pre3819*` and
`MutFileLessNoTicketKey`/`MutStaleSlotNoDiscard` configs keep row 17 (no
`namedSuccessor`). After #3855 a start that the primary did not name still
registers in two cells: residual R3 (`AcceptedR3InMemoryNew`; a `/new`
successor reads no slot) and a real successor that starts after the
marker's 60 s bound, behind a later `startup` (not modelled: no time).
#3819's `demotedDiscard` guards the second, and its `ticketKey` is what lets
a file-less successor find its slot at all (`H3FileLessCarry`).

**F4. Today, a subagent's read authorises the primary's edit** (#3613). The
shared read guard puts a subagent's read in the primary's cell
(`MutSecondaryReadShared` and `Current`).

**F5. An interrupted start's shutdown re-keys the slot; skipping the stash
is not enough (#3881).** The interrupted start never adopted, so the slot
left for it is the conversation's state. Model mutations of
`forwardUnadopted` on `H3Interrupted` / `H3InterruptedFileLess`:

- Leaving the slot as it is (no stash, no re-key) violates `HandoffOnce`
  file-backed (61 states: the inner reload's start takes a slot written by
  a scope it did not replace) and `NoLostActivation` file-less (363
  states: the inner reload's start finds no slot keyed by its manager's
  ticket).
- Re-keying without the interrupted scope as the writer violates the same
  two (61 and 363 states).
- Keeping the start's reason violates `NoLostActivation` (362 states): a
  `/fork` start's slot never matches the inner `/reload`'s start.
- Re-keying any slot rather than the one left for the start passes inside
  the bounds (no stale slot is reachable in three steps); the unit test
  `forwards the slot left for an interrupted start to that session's next
  start, and no other slot` pins it.
- Forwarding every store rather than the ones the start's own reason
  adopts (#3881 r1) violates `AdvisoryStaysInSession`
  (`MutInterruptedForkPolicy`): an interrupted `/fork` takes the parent's
  advisory under the `/reload` policy. Its authorship crosses the same way
  (`read-guard-authorship`: fork reset, reload adopt), but `RG` conflates
  authorship with reads, so the model cannot see that half; the runtime
  witness `gives a file-backed /fork interrupted by a reload none of the
  parent's authorship or advisories` pins it.

**F6. A subagent's own `/fork` or `/reload` does not carry its activations
(#3855's answer to the #3835 r2 question).** A secondary never stashes,
saves a sidecar or adopts: S2's one slot is the primary's (F2), and
`adoptHandoff` runs only for a primary start. So a subagent's own
replacement starts with the default tool set, whether or not it lands in a
primary's gap (`AcceptedSecondaryForkActivation`). The merged design accepts
it: carrying them needs a hand-off of the secondary's own, which is new
mechanism on the S2/S4 seam and a maintainer decision. A secondary hand-off
would flip that config to `pass`. `NoLostActivation` covers the primary's
conversations and `SecondaryKeepsActivation` the subagent's.

**F7. Only the start the primary named is primary in its gap (#3855
round 2).** Round 1 (`inheritRole`) marked the starts that are not the
successor, with a note per secondary replacement; its review found three
cells the idealised model hid, now modelled: a subagent's own in-memory
`/new` leaves no note (R1, `Mut3855r1SecNew`), a demoted conversation's note
declines its own later replacement (`Mut3855r1DemotedReplaces`), and a note
whose start never comes declines the primary's resume of that file
(`Mut3855r1StaleNote`); eviction at the cap demotes the real successor
again (`Mut3855r1Evicted`). The merged rule (`namedSuccessor`) uses the
identity the primary holds, the hand-off key of the successor it names, and
passes all four. Round 3 removed round 2's key-less fail-safe (J6,
`Mut3855r2KeylessFailSafe`): it compensated for a test double, and pi hands
a `/reload` or in-memory `/fork` successor its predecessor's manager, so the
named successor never arrives key-less; in pi it let an SDK subagent's
replacement-reason bind take the slot (`H3SdkBind`). `Begin` now checks its
own key, so `HasPrimary` constrains the merged rule. Round 4 made
`Interrupt` name its gap as the code does (verify r3 V4); the earlier
abstraction named a ticket the code never bound, which hid V3, and the
forward bound one (`bindInterrupted`). Round 5 moved the binding to the
naming site (`nameAtShutdown`), which every primary shutdown passes through
in every window of the start (`InterruptAt`, verify r4 V6). Its residual R3 (`AcceptedR3InMemoryNew`): in the
primary's own in-memory `/new` gap, a subagent's own in-memory `/new`
carries the same pair, so the first is primary; the process still has one
primary.

**Confirmations.** D3: `PreS2SnapshotAtBeforeFork` violates `NoLostCarry`.
D5: `PreS2ReloadReset` violates `NoLostCarry`. Carrying authorship on
`/reload` is required, not merely safe.

## Scope

Not modelled:

- **Content.** Staleness, FileTime, hashes and ranges are covered by
  `formal/read-guard`; the quiet window's tasks by `formal/session-straddle`;
  the drain by `formal/format-drain`; the registry lock and tail by
  `formal/session-registry`.
- **Authorship as a store of its own.** `RG` conflates it with reads (see
  above), so the model does not show authorship crossing under #3819.
- **S3's non-read-guard writers** (turn-state ranges, the turn summary, the
  git-guard latch, the debounce re-entry) and the fail-open external bridge
  producer (#3763); the deferral queue's two-hop credit (#3705). `svc` is
  one process counter, which is the merged behaviour (#3755).
- **The interrupted start's own continuation (#3881).** When another
  extension's `session_shutdown` handler awaits, pi has not yet invalidated
  the interrupted start's ctx, so that start runs on after its shutdown;
  the code returns before `adoptHandoff` once its shutdown ran. `Interrupt`
  is one step, so the model never reaches that continuation; the runtime
  witnesses' "the start runs on" axis pins it
  (`tests/index-3521-fork-tree-witness.test.ts`). An interrupt between the
  slot take and the end of `adoptHandoff`'s synchronous restores (a
  microtask-driven reload) is not modelled either.
- **#3668's successor marker and its expiry.** A replacement whose successor
  never starts (row 15), and a `session_start` that crashed before its scope
  was set, are not modelled; either leaves an untaken slot that only a start
  without its own stash could adopt, as in #3819. Row 17 is modelled for a
  subagent's own `/reload`, `/fork` and `/new` (file `U`); its own resume is
  not modelled (its start carries pi's target file, as a persisted `/new`
  does). The marker's 60 s bound is not modelled either.
- **`MutGenPerEval` (#3755).** A follow-up needs its own discriminator:
  in the #3835 review, `NoCrossSessionState` could not see a
  per-evaluation LSP generation (the mutant passed, 291 states), while
  `\A srv \in fleet : st[srv.o] = "live"` redded it (77 states) and held on
  the unmutated model (161).
- **`formal/session-straddle`** is not re-baselined here; its generation is
  still an equality counter bumped at `resetForSession`.
- **#3587** (a shutdown that meets this process's own registry lock skips
  the deregistration), and secondary registry roots.
- **The ALS hazard of D2**, **D4** (tool-call id reuse across branches), and
  **N5** (the turn summary and test-runner delivery after `/tree`).
- **The widget's write token.** `WidgetWrite` allows one write per turn, and
  its token is the bare order turn, so the guard's `>=` and `>` cannot be
  told apart, and neither can the fork row's `carry` and `reset`.
- **Time**, the cwd-changing resume's re-evaluation, the MCP host, the
  advisory cap, and more than one subagent.
