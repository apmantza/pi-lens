# Dispatch pipeline model

A TLA+ model of one file on the post-write dispatch path. The agent edits
the file. Each edit's `tool_result` handler starts a pipeline run. The runs
write per-file stores, and pi-lens' own in-place autofix writes the file. The
`TLA+ models` CI job (`node scripts/check-tla-models.mjs`) checks every
config here against its `\* expect:` line.

Issues: #3506, #3507, #3508.

## What the model covers

- **The agent.** It makes edits 1..N of file F, in order. Each edit is a
  read-modify-write under pi's per-file `withFileMutationQueue`
  (pi-coding-agent `core/tools/edit.js`). With `Parallel`, which is pi's
  default `toolExecution` (`agent-loop.js` `executeToolCallsParallel`), edit
  i+1 can execute while edit i's handler is still running. Without it, pi
  awaits the handler (`afterToolCall`), unless the handler's 10 s bound
  abandons it (`Orphan`: `index.ts` ~2733 `bounded(handleToolResult(...))`;
  `bounded` does not cancel the work).
- **Handler and pipeline i** (`runtime-tool-result.ts`, `pipeline.ts`). Each
  step boundary is an await:
  1. `Hash`: `postWriteStateHash` (~2072), `claimPipelineDispatch` (~436:
     in-flight dedupe on (file, hash), then the already-analysed latch), and
     `nextWriteIndex` (~2185). When the clients are resident, the same
     synchronous block also covers `registerInFlightPipeline` (~918),
     `admitWidgetDiagnosticsWrite` (pipeline.ts ~1435) and the content read
     (~1449).
  2. `Gap` (`ClaimGap`): `await bounded(classifiedClients)` (~2324), which sits
     between the claim and the registration when the clients are not
     resident.
  3. `FixRead` / `FixWrite`: the in-place fixer (`runAutofix`, for example
     `biome lint --write`) reads F and later writes its fix of what it read.
     Only a turn's first `write` runs this (`recordMutationToolReceipt`: edits
     are deferred).
  4. `Refresh`: the before/after compare (biome-client.ts ~409), the content
     refresh, and the `postWriteStateHash` capture (pipeline.ts ~1560-1600).
  5. `Analyse`: `dispatchLintWithResult` returns, and `recordDiagnostics`
     writes the widget store under its `WriteOrderingGuard`.
  6. `Release`: `releaseInFlightPipeline` (deletes by hash key), and the
     already-analysed latch is set.
  7. `Record`: the handler's `recordInlineBlockers` / `clearInlineBlockers`
     (~2540 / ~2553). This is the turn-end "Unresolved from this turn" record,
     and the git-guard latch aggregates it (`runtime-coordinator.ts` ~530).

A content value is the set of agent edits it contains plus a "fixed" bit, so
a fixer that writes back stale bytes shows up as a missing edit. Whether a
content has a blocker depends on the newest edit it contains; the assignment
is chosen at Init, so every assignment is checked.

## Invariants

| Invariant | Promise | Source |
|---|---|---|
| `InlineNewest` / `InlineExact` | at quiescence the inline-blocker record (and the git guard built from it) is the verdict on the newest revision | "a slow old clean ... must not erase" a newer blocker: `runtime-coordinator.ts` ~158-163, ~1353-1356 (#1198 invariants 1-2) |
| `WidgetNewest` / `WidgetExact` | the widget store ends on the newest revision (`Exact`: on the exact bytes, pi-lens' fix included) | `widget-state.ts` ~305-315 |
| `NoLostEdit` | an autofix never overwrites an agent edit | pi `docs/extensions.md` ~1925: an extension that mutates files must use `withFileMutationQueue` |
| `NoForeignAttribution` | what the pipeline reports as its own autofix write contains no agent edit that the fixer did not read | `pipeline.ts` ~1576-1600 (`fileModified`, `postWriteStateHash`, the "authoritative" attachment) |
| `NoDoubleDispatch` | no two pipelines analyse one (file, state) concurrently | `runtime-tool-result.ts` ~402-431, ~2128-2132 ("Nothing may await between this claim and the dispatch") |

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
| `FixerParallel` | fixed code (#3506) | pass | 840 |
| `FixerOrphan` | fixed code (#3506), handler abandoned | pass | 1,664 |
| `FixerAttribution` | fixed code (#3506) | pass | 840 |
| `FixerQueue` | fixed code (#3506), three edits | pass | 829,712 |
| `MutFixerNoQueue` | #3506 without part 1 (the code before it) | violated `NoLostEdit` | 156 |
| `FixerQueueWriteOnly` | #3506 without part 2 | violated `NoForeignAttribution` | 218 |
| `FixerQueueNoReToken` | #3506 without part 3 | violated `WidgetNewest` | 24,746 |
| `ClaimAtomic` | resident clients | pass | 797,392 |
| `ClaimGap` | fixed code (#3508) | pass | 264 |
| `MutClaimGap` | the code before #3508 | violated `NoDoubleDispatch` | 57 |
| `MutNoInflightDedupe` | the claim without the in-flight dedupe | violated `NoDoubleDispatch` | 68 |
| `AllActorsFix` | all three fixes | pass | 43,512 |
| `AllActorsFixOrphan` | all three fixes, handler abandoned | pass | 804,400 |

Non-vacuity:
- The widget's existing guard is load-bearing: `MutWidgetNoGuard` goes red.
- The in-flight dedupe is load-bearing: `MutNoInflightDedupe` goes red.
- pi's own serialisation of the handler is what kept `InlineSequential` and
  `FixerSequential` green before the fixes. `InlineParallel`, `FixerParallel`
  and `FixerOrphan` remove it.

## Bugs (all four reproduced on the real code, all fixed)

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
  red. The code takes the hold at the first format or autofix write, so a
  pipeline with no writer never waits on the queue.
- **Claim (#3508).** The clients are awaited before `claimPipelineDispatch`,
  as the observed path already did. This is `ClaimGap = FALSE`.

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
- external writers other than pi's edit tools.

Assumptions:
- A fixer writes a fix of the bytes it read.
- A blocker verdict is a function of the newest agent edit in the content.
- Handlers of one batch run in the order their edits executed.
