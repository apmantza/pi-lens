# Dispatch pipeline model

A TLA+ model of one file on the post-write dispatch path. The agent edits
the file. Each edit's `tool_result` handler starts a pipeline run. The runs
write per-file stores, and pi-lens' own in-place autofix writes the file. The
`TLA+ models` CI job (`node scripts/check-tla-models.mjs`) checks every
config here against its `\* expect:` line.

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

TLC 2.19 (`tla2tools.jar` v1.7.4), 4 workers.

| Config | Expect | Distinct states | s |
|---|---|---|---|
| `InlineSequential` | pass | 152 | 2 |
| `InlineParallel` | violated `InlineNewest` (bug 1) | 256 | 2 |
| `InlineFix` | pass | 8,176 | 4 |
| `InlineFixNoRecord` / `NoClear` / `NoTomb` | violated `InlineNewest` | ~260 each | 2 |
| `WidgetParallel` | pass | 732,720 | 28-44 |
| `MutWidgetNoGuard` | violated `WidgetNewest` | 819 | 2 |
| `FixerSequential` | pass | 176 | 2 |
| `FixerParallel` | violated `NoLostEdit` (bug 2) | 141 | 2 |
| `FixerOrphan` | violated `NoLostEdit` (bug 2) | 170 | 2 |
| `FixerAttribution` | violated `NoForeignAttribution` (bug 2) | 229 | 2 |
| `FixerQueue` | pass | 829,712 | 37 |
| `FixerQueueWriteOnly` | violated `NoForeignAttribution` | 218 | 2 |
| `FixerQueueNoReToken` | violated `WidgetNewest` (bug 4) | 24,746 | 4 |
| `ClaimAtomic` | pass | 797,392 | 27 |
| `MutNoInflightDedupe` | violated `NoDoubleDispatch` | 68 | 2 |
| `ClaimGap` | pass (fixed code, #3508) | 264 | 1 |
| `MutClaimGap` | violated `NoDoubleDispatch` (bug 3: the code before #3508) | 57 | 1 |
| `AllActorsFix` | pass | 43,512 | 7 |
| `AllActorsFixOrphan` | pass | 804,400 | 28 |

Non-vacuity:
- The widget's existing guard is load-bearing: `MutWidgetNoGuard` goes red.
- The in-flight dedupe is load-bearing: `MutNoInflightDedupe` goes red.
- pi's own serialisation of the handler is what keeps `InlineSequential` and
  `FixerSequential` green. `InlineParallel`, `FixerParallel` and
  `FixerOrphan` remove it.

## Bugs (all four reproduce on the real code)

1. **The inline-blocker record is last-completer-wins** (`InlineParallel`).
   The handler records or clears the record with no order check. The record
   stores `writeIndex` but never compares it. An older clean run that
   settles last erases the newer edit's blocker, and the git guard
   unlatches. An older blocker that settles last replaces the newer verdict
   with a `writeIndex: 1` record. The widget store, which has the guard,
   keeps v2 in both cases.
2. **The immediate autofix runs outside pi's mutation queue** (`FixerParallel`,
   `FixerOrphan`, `FixerAttribution`). Take a turn's first `write` followed by
   an edit of the same file, either in one parallel batch or after the
   write's pipeline outlived its 10 s bound. The fixer's stale write erases
   the agent's edit, and the tool result calls the erased content
   "authoritative". An agent edit inside the fixer's before/after window is
   instead claimed as pi-lens' autofix. Its hash then becomes the
   already-analysed latch, and the edit's own tool result is empty.
3. **The claim is not atomic when the clients are not resident**
   (`MutClaimGap`; fixed by #3508, `ClaimGap`). The classified path awaited
   the bootstrap clients after `claimPipelineDispatch`, so two handlers for
   one post-write state both ran the pipeline.
4. **A refreshed pipeline keeps the handler's `writeIndex`**
   (`FixerQueueNoReToken`). A pipeline whose autofix ran on a newer revision
   analyses those bytes under the older token. The ordering guard then keeps
   an older verdict, while the newest edit's own run was skipped by the
   latch. For the latch to skip it, that edit's handler must hash the file
   after the older pipeline has finished, so this needs a delayed handler.

## Candidate fixes (checked)

- **Inline record.** Record and clear go through one per-path
  `WriteOrderingGuard` on `writeIndex`: compare on record, compare on clear,
  and keep the token across a clear. Dropping any of the three parts turns
  it red.
- **Autofix.** Run the fixer inside `withFileMutationQueue(F)` (part 1),
  and hold the queue through the after-read, refresh and hash (part 2).
  After a refresh that moved the bytes, take a fresh `writeIndex` (part 3).
  Without part 2, `FixerQueueWriteOnly` goes red; without part 3,
  `FixerQueueNoReToken` goes red.
- **Claim.** Await the clients before `claimPipelineDispatch`, as the
  observed path already does (~1892 before ~1916). This is `ClaimGap =
  FALSE`.

## Scope and assumptions

Not modelled:
- several files;
- the cascade;
- the LSP touch/notify queue: it is the `Analyse` await, and
  `formal/lsp-server-content` covers it;
- turn and session boundaries (`sessionGeneration`, the latch's
  `turnIndex`);
- the debounce: its default is 0;
- the deferred `agent_end` format/autofix drain;
- collect-later runners: they share `formal/late-aux-drain`'s freshness-gate
  shape;
- the dispatcher's delta baseline;
- external writers other than pi's edit tools.

Assumptions:
- A fixer writes a fix of the bytes it read.
- A blocker verdict is a function of the newest agent edit in the content.
- Handlers of one batch run in the order their edits executed.
