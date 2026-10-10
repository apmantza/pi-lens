# Tree-sitter trap budget model

Can a web-tree-sitter wasm trap in one input cost another input its parse,
poison the runtime before the budget's evidence is in, or leave a degraded
result cached after its cause is gone? pi-lens runs one wasm instance per
process. A trap is contained to its input: it is charged to a per-input entry,
and the process budget (`WASM_TRAP_BUDGET`, 3) bounds how many traps the heap
may absorb before the runtime is treated as aborted.

The `TLA+ models` CI job (`node scripts/check-tla-models.mjs`) checks every
config here against its `\* expect:` line.

Issues: #3605, #3678, #3707, #3803 (lane L4). PRs: #3673 (containment and the
per-input map), #3706 (decay, identity, keyed extractor compile), #3731 (keyed
batch compiles, no cache of a trapped build). #3797 audited the mutation
survivors of all three; it found no real bug, and the tests below are the
ones it kept.

## What is modelled

One process. The model holds the trap map (`trappedInputs`), the budget
counter (`wasmTraps`), the batch cache (`queryBatchCache`), the raw query
cache (`queryCache`) and the extractor memos. It has these callers:

- `Parse(f, id)`: `parseFileAndUse` for file `f` and caller `id`. That covers
  the charged skip, the parse, the parse-phase clear, `consume` and its
  clear. The four caller identities are `rg` and `mr` (extractors that
  rethrow a trap) and `rqA` and `rqB` (`runQueriesOnFile` over rule sets A
  and B). The last two share the label `rq` and swallow a trap.
- `Edit(f)`: a new content value, so the file gets a new input. Two files can
  end up with the same content, and then they share an entry, as in the code.
- `ExtInit(o)`: the symbol extractor's `compileQuery` at one owner's memoized
  init. The three owners are the review-graph builder, module-report and
  blocker-freshness.
- `RawCheck(r)`, then `RawDo(r)`: `compileRawQuery`. The charged check and the
  compile are separated by `await loadLanguage` and `await
  loadWebTreeSitter()`.
- `BatchCheck(n)`, then `BatchBuild(n)`: `compileQueryBatch` for rule set `n`.
  The batch-key check comes before `await loadWebTreeSitter()`. The probe
  loop and the combined compile after it are synchronous. Rule sets A =
  {r1, r2} and B = {r2} share rule r2's probe key.
- `BatchEvict(n)` and `RawEvict(r)`: cache eviction, or a rule edit that
  reloads a rule set.

Each action is one synchronous region of the code, so the model's
interleavings are the code's await points. Two or more calls in flight are
allowed where the code awaits between a check and its compile (`MaxPend`).

The environment picks trap outcomes:

- A poisoned site (`poison`, chosen at Init from `PoisonCandidates`) traps
  every time. This is an input-driven trap.
- Any other site may trap as a one-off, at most `MaxHeap` times in a run. This
  is heap damage that the input did not cause.
- `Flaky` lets a poisoned site also succeed: an input-driven trap that is
  stateful (#3706 residual R1).

The ghosts `hits`, `poisonHit` and `heap` record each trap's true culprit. They
are the evidence that the budget is allowed to spend.

The model's `ok-build`/`raw-ok` transitions invalidate every cached batch after
a healed query input. The implementation invalidates only batches whose stored
input-key mirror contains that healed input. This is a deliberate
over-approximation in the model: it proves the safety property for a larger
invalidation set while the code preserves unrelated cached batches.

## Invariants

- `Contained` (#3605, #3673). A call loses a file's extraction only through
  that file's own input, meaning its own trap or its input being charged, or
  once the runtime is poisoned. A trap in file A never costs an unrelated
  file B.
- `BudgetOnEvidence` (#3605's budget; #3706 and #3731 in the abort
  direction). `spent <= |inputs that trapped deterministically| + one-offs`:
  each input costs at most one unit, and each one-off costs at most one. So
  the runtime is never poisoned before `Budget + 1` distinct pieces of
  evidence, and no decay lets one input spend twice. This is the audit's
  `NoAbortBeyondMaster` and `TwoTrapsPerInput`, stated as the per-state bound
  they both follow from.
- `NoKeyLeak` (#3731 FL10). A charged key skips every input it stands for, so
  each of those inputs trapped at least twice itself.
- `DecayOnOwnSuccess` (#3706 F-A). An entry does not survive a clean success
  by the identity that trapped. The extractor's compile key is exempt: it has
  no clear and no charged skip, so a stale entry there can only make a later
  trap free, never skip anything.
- `NoRunWhenCharged` (#3605 K4). A site that checks the charge never runs a
  charged key. Those sites are the parse, the batch probe, the batch key and
  `compileRawQuery`. A compile that runs past a check that passed (`RawDo`,
  or the combined compile in `BatchBuild`) is the race window, not a missed
  skip.

The ghosts behind the last two, `stale` and `attempted`, are written by each
action at its own site: `Mark` after a clean success, `Try` before a checked
site runs. They are never written inside `Clr` or inside the skip test. So a
site that omits its heal or its skip is still seen (review F1 on #3829). The
table below lists the sites and the configs each one reds when removed.
- `NoCachedTransient` (#3731). A cached batch is degraded only for a permanent
  reason: every rule it lacks has a charged probe key, and a cached null has a
  charged batch key or no rule left, or the runtime is poisoned.
- `TypeOK`. Counts are in `0..2` (they never go negative). `2` stands for
  "charged": the code only ever tests `> 1`.

The audit's `NoCrossIdentityHeal` is not a separate invariant. A cross-identity
heal is only harmful because it lets a deterministic trap spend again, and
`BudgetOnEvidence` catches that consequence (MutF2, MutF4). A ghost that
compared the healer with `by` would restate the code's comparison.

## Results

### Grammar retirement projection (#4010)

`GrammarRetirement.tla` is a per-language projection of the retirement state
(`grammarTrapInputs`, `retiredGrammars`, the budget). Each input is one distinct
set of bytes; the environment decides whether it traps every time (persistent:
trap, trap again on a retry, then charged) or once (a one-off that parses
cleanly on its retry). `Trap` adds the input to the grammar's set on every trap
and retires at `LatchThreshold` inputs; only a first trap spends budget, and
past `Budget` the process aborts. `Heal` is the trapper's own success and
removes the input from the set (`Decay`).

Invariants: `SetIsLive` (the set is exactly the inputs that trapped and have not
healed: decay), `RetiredIffTwoLive` (retired exactly when two inputs were live
at once: never on healed one-offs, never missed), `NoAbort` (retirement comes
before the abort: #4010's outcome). `GrammarRetirement.cfg` passes all three;
`GrammarRetirementNoDecay` (no `delete` on success) violates `SetIsLive`;
`GrammarRetirementLateLatch` (threshold 3) violates `NoAbort`; the
`GrammarRetirementReach*` configs violate `NeverRetired`, `NeverHealed` and
`NeverCharged`, so retirement, decay and the charged path are all reachable in
the good config's population (it is not vacuous). `NoAbort` holds only while
the one-offs that spend budget first number at most `Budget - LatchThreshold`;
the good config has one.

The retirement model is independent of `TreeSitterTrapBudget`: it does not
model `trappedInputs` identity (caller, keys), only the first-trap/charged
split the retirement reads.

TLC 2.19 (`tla2tools.jar` v1.7.4), `-workers 1`, on `cf1b548e5`.

| Config | Behaviour | Verdict | Distinct states |
|---|---|---|---|
| `GrammarRetirement` | #4010: one one-off and three persistent inputs, T = 2, budget 3, decay on | pass | 39 |
| `GrammarRetirementNoDecay` | #4010 mutant: no removal on the trapper's success | `SetIsLive` violated (3) | |
| `GrammarRetirementLateLatch` | #4010 mutant: threshold 3 | `NoAbort` violated (6) | |
| `GrammarRetirementReach` / `ReachHeal` / `ReachCharged` | non-vacuity for `GrammarRetirement` | `NeverRetired` (3) / `NeverHealed` (3) / `NeverCharged` (3) violated | |
| `MergedFiles` | master: parse/consume, 2 files, 3 consumers, 4 poison candidates, 2 one-offs | pass | 39,364 |
| `MergedExtractor` | master: extractor compile at 3 owners | pass | 27 |
| `MergedBatch` | master plus #3834's two batch defences: one build per rule set in flight (see below) | pass | 1,879 |
| `MergedBatchRaw` | master: batch compiles plus a concurrent `compileRawQuery`, at most one one-off | pass | 6,183 |
| `ReachAbort` / `ReachCharged` / `ReachSkipCached` | non-vacuity for the pass configs | `NeverAborted` / `NeverCharged` / `NeverSkipCached` violated | |
| `Pre3673` | before #3673: a consume trap rejects the whole build | `Contained` violated (2 states) | |
| `Mut3673NoKeying` | #3673 round 1, review F1: every trap spends | `BudgetOnEvidence` violated (3) | |
| `Pre3706` | before #3706 (F-A): no decay | `DecayOnOwnSuccess` violated (3) | |
| `Pre3706Extractor` | before #3706 (F-C): unkeyed extractor compile | `BudgetOnEvidence` violated (3) | |
| `MutF1` | #3706 F1: the swallowing consumer clears its own raised entry | `BudgetOnEvidence` violated (3) | |
| `MutF2` | #3706 F2: any consumer's success decays the entry | `BudgetOnEvidence` violated (4) | |
| `MutF4` | #3706 F4: identity is the label only | `BudgetOnEvidence` violated (4) | |
| `MutF5` | #3706 F5: the parse key carries the caller | `BudgetOnEvidence` violated (3) | |
| `MutF6` | #3706 F6: the consume key carries the caller | `BudgetOnEvidence` violated (3) | |
| `ResidualR1` | master, stateful input-driven trap | `BudgetOnEvidence` violated (4): #3706's disclosed R1 | |
| `Pre3731Cache` | before #3731: a trapped build is cached | `NoCachedTransient` violated (3) | |
| `Pre3731Budget` | before #3731: unkeyed probe | `BudgetOnEvidence` violated (5) | |
| `MutNoCacheGuard` | #3731 FL3/FL4: keyed, but a trapped build is cached | `NoCachedTransient` violated (3) | |
| `MutConstBatchKey` | #3731 FL10: one batch key for every rule set | `NoKeyLeak` violated (5) | |
| `RaceRawHeal` | #3834 fixed: a concurrent `compileRawQuery` invalidates stale batches | pass | |
| `RaceBatchHeal` | #3834: `BatchHealDrop` is the only defence (`Coalesce` off, `MaxPend = 2`) | pass | |
| `RaceBatchCoalesce` | #3834: `Coalesce` is the only defence (`BatchHealDrop` off, same bounds) | pass | |
| `Mut3834BatchRace` | #3834 with both batch defences off: the two-build race | `NoCachedTransient` violated | |

Two model defences hold `NoCachedTransient` against the two-build race, and
**either one alone is sufficient**, so no single config can prove both.
`Coalesce` is `queryBatchBuilds`: one same-key build admitted at a time.
`BatchHealDrop` is the trapped branch's arm: a build that heals its own charged
batch key drops the stale null that a concurrent `BatchCheck` cached against it.
Each defence has a config where it is the only one standing, and flipping either
switch in a pass row lands on the violation row:

| Config | `Coalesce` | `BatchHealDrop` | Verdict |
|---|---|---|---|
| `RaceBatchHeal` | FALSE | TRUE | pass: the heal-drop alone holds |
| `RaceBatchCoalesce` | TRUE | FALSE | pass: the coalescer alone holds |
| `Mut3834BatchRace` | FALSE | FALSE | `NoCachedTransient` violated |

Round 5 claimed that deleting the coalescing guard from `RaceBatchHeal` violated
the invariant. The round-5 verify measured that it does not, because
`BatchHealDrop` covers the same race, and that claim is retracted here: with one
defence hidden by the other, the single config proved "at least one of them" and
no more. `Coalesce` is also vacuous wherever `MaxPend = 1`, which every config
except these three uses, so those rows keep both switches at the production
value and mean exactly what they meant before.

**Master does not satisfy `NoCachedTransient` unrestricted**: `Mut3834BatchRace`
is master's batch behaviour on both switches. `RaceRawHeal` adds a concurrent
raw compile, which `RawDo`'s invalidation covers. Likewise, `MergedBatchRaw`
passes only because it allows one one-off, below the two the race needs.

Not modelled, and pinned by runtime tests instead: the publication epoch
(`queryBatchHealEpoch`) and the consumer lease (`QueryBatch.users`). The model
has no lease and no native-disposal state, so it says nothing about a build that
refuses publication after an external heal moved the epoch, and nothing about
disposing a batch under a scan that still holds it. Those cells are
`tests/clients/tree-sitter-heal-batch-cache.test.ts`: `does not cache a batch
after its build heals an input (#4207 F7)`, `leases every coalesced consumer at
publication, before a heal can dispose (#4207 F9)`, `disposes an epoch-skipped
build once its coalesced consumers release it (#4207 F10)`, and `records the
deferred disposal of a trapped build it refuses to publish (#4207 F10)`.

The three #3834 batch rows above are expectations, not measurements from this
lane: `java` is absent here, so `scripts/check-tla-models.mjs` could not run.
Each maps onto one row the round-5 verify measured on this same model with the
defence deleted from the `.tla` instead of switched off (`Coalesce` off is its
"guard removed" pass, `BatchHealDrop` off is its "clause removed" pass, both off
is its "both removed" violation). CI's `TLA+ models` shards are the authority.

The number in brackets is the trace length in states. Each pre-fix config sets
its switches to that code's behaviour, and each mutant flips one switch from
master's. Pre-fix and mutant configs enable only the actions their trace needs,
so the target invariant is the first one TLC reports. `Pre3731Budget` checks
only `BudgetOnEvidence`, because the same pre-fix code violates
`NoCachedTransient` two steps earlier (`Pre3731Cache`).

## Finding 1: a compile past its charged check heals a key that a cached batch skipped

`#3731`'s state table says (row B6): "a charged key is never compiled again in
the process ... so the cached result equals what an uncached rebuild would
return". That holds for one call at a time. It does not hold across the await
between `compileRawQuery`'s charged check and its compile. The same gap exists
between `compileQueryBatch`'s batch-key check and its combined compile.

`RaceRawHeal`, on master:

1. `runQueryOnFile(r1)`: the raw compile traps once (one-off). r1's entry is
   at 1, and one budget unit is spent.
2. `runQueryOnFile(r1)` again: the charged check passes (1 is not > 1), and
   the call awaits `loadLanguage`.
3. `runQueriesOnFile([.., r1])`: r1's probe traps once (one-off). The entry
   goes to 2, so r1 is charged. This build trapped, so it is not cached.
4. `runQueriesOnFile` again: the probe skips charged r1, and the batch
   without r1 is cached.
5. The call from step 2 resumes, compiles r1 cleanly, and `clearWasmInput`
   deletes r1's entry.

Now r1 is healthy and `runQueryOnFile(r1)` matches. Before #3834, the cached
batch still omitted r1; `queryBatchCache` is a 256-entry `BoundedFifoMap`, so
the omission could last until that entry was evicted, possibly for the life of
the process. The fix disposes and clears cached batches when r1 heals, forcing
the next batch call to rebuild from the healthy rule set.
`RaceBatchHeal` shows the same shape on the combined compile with three
one-offs: a null is cached against a batch key that a late build has already
healed, and every scan then pays the per-rule fallback. `RaceBatchHeal.cfg`
keeps `MaxPend = 2` and switches `Coalesce` off, so that race stays reachable
and `BatchHealDrop` is what closes it; `RaceBatchCoalesce.cfg` runs the same
bounds the other way round, with the coalescer on and the heal-drop off.

The premise was checked through the real `TreeSitterClient` with a real
python grammar. A scratch probe, not committed, injected the traps at the
`Query` constructor and held step 2's `loadLanguage`. Its output:

```text
["after raw trap",[{"traps":1}],1]
["builds",["ok"],["ok"],[{"traps":2}],1]
["raw after release",1,[]]
["after heal",{"batch":["ok"],"rawMatches":1,"entries":[]}]
```

The trigger for `RaceRawHeal` is one earlier one-off trap on the source
(step 1, before the in-flight call's check), plus one more while a compile
that passed its check is in flight (step 3). Only the second trap falls
inside the window.

For `RaceBatchHeal`, all three one-offs fall inside the window of a build
that passed its batch-key check:
- two traps on the combined compile, which charge the batch key, after which
  a third build caches the null;
- one probe trap in the late build itself, so that build does not cache its
  healthy result over the null.

Review reproduced both races through the real client. It reached the raw race
without an artificial hold: 23 of 594 microtask launch offsets hit it, the
simplest being three calls launched in one tick.

Severity is low. The effect is one rule missing from batched scans (or the
batch falling back to per-rule walks), never a wrong finding or an abort.
Tracked as #3834. The committed regression drives the same compiler seam with a
held `loadLanguage` and a one-off probe trap, then asserts that the healed batch
contains r1 again.

## Provenance (master `cf1b548e5`)

| Model element | Code |
|---|---|
| `Rep` | `TreeSitterClient.reportWasmAbort` in `clients/tree-sitter-client.ts` (the `trappedInputs` entry, `++this.wasmTraps <= WASM_TRAP_BUDGET`, `wasmAborted`) |
| `Clr` | `TreeSitterClient.clearWasmInput` (`by === input.caller`) |
| file key `FKey(c, NoId)` | `wasmInputKey` (sha256 of `languageId` and `source`); `parseFileAndUse` builds `input = { languageId, source: content }` with no caller |
| consume identity | `parseFileAndUse`'s `input = { ...input, caller }` and the `trapsBefore` guard (#3706 F1) |
| query keys `PKey`, `BKey`, `EKey` | `wasmQueryInput`; `compileQueryBatch`'s `probeInput` (the rule's `raw:<id>:<query>` key, shared with `compileRawQuery`) and `batchInput` (`cacheKey`); the extractor's `wasmQueryInput(`${languageId}:${label}:${src}`)` in `clients/tree-sitter-symbol-extractor.ts` `compileQuery` |
| charged skip | `wasmInputTraps(input) > 1` in `parseFileAndUse`, `compileQuery`, `compileRawQuery` and `compileQueryBatch`'s `build` |
| `CacheGuard` | `if (!trapped) this.cacheQueryBatch(cacheKey, batch)` in `compileQueryBatch` |
| `Coalesce` | `queryBatchBuilds` in `clients/tree-sitter-client.ts`: `compileQueryBatch` registers one build per cache key and a concurrent caller awaits it instead of compiling again |
| `BatchHealDrop` | `clearWasmInput(batchInput, true)` in the combined compile, which deletes and retires the cached batches whose input mirror holds the healed key |
| swallowing consumers | `runQueriesOnFile`'s and `runQueryOnFile`'s `reportWasmAbort(err)` catch inside the consume region (`activeWasmInput`) |
| rethrowing consumer, pre-#3673 build loss | `extractTreeSitterSymbols` in `clients/review-graph/builder.ts`; before #3673 the consume trap rejected `_doBuildGraph` (#3673 Summary) |
| extractor owners | `getExtractor` memo in `clients/review-graph/builder.ts`, `clients/module-report.ts`, `clients/blocker-freshness.ts` |
| batch cache | `queryBatchCache` (`BoundedFifoMap`, `QUERY_BATCH_CACHE_MAX_ENTRIES`) |

The tests that pin the modelled cells are
`tests/clients/tree-sitter-wasm-trap.test.ts` (containment, keying, budget,
session reset), `tests/clients/tree-sitter-trap-decay.test.ts` (F-A, F1, F2,
F4, F5, F6), `tests/clients/tree-sitter-batch-compile-trap.test.ts` (#3731 FL1
to FL10), `tests/clients/review-graph/wasm-trap-decay.test.ts`, and
`tests/clients/tree-sitter-heal-batch-cache.test.ts` (#3834: the raw heal, the
batch heal, the publication epoch and the consumer lease).

## Scope

`TreeSitterTrapBudget` has no per-language trap count; `GrammarRetirement`
(above) models the per-language set of distinct trapping inputs that retires a
grammar. A language is part of each input's key, since the key hashes the
`languageId`. Per-language failures that are not
traps (`Language.load` failing, which charges the grammar file and allows a
re-fetch; a batch whose grammar failed to load) sit outside the budget and
are not modelled. The same goes for the trap classifier, the parser and
tree-cache recycle, and the builder's `_wasmTrappedFiles` re-extraction
(#3673 F2).

Sessions are not modelled because every piece of trap state is
process-lifetime and no session reset touches it. That is pinned by `keeps
the budget across a session reset`.

These paths are also left out:

- A trap object reported at two sites (`reportedTraps` dedupes it). Every
  trap is reported once.
- The two-source extractor case (#3706 F3).
- The `withTreeSitterRoot` callers (#3706 F4). Their identities are more
  consumers of the same shape as `rg`.
- The tree-cache retire observer and `init()` catch. They report with no
  input and spend a unit each, like a one-off.
- The client's own `compileQuery` (the structural-search path). It has a
  charged check and a heal on its `<lang>:<pattern>` key, the same shape as
  `compileRawQuery`, but no action here. That key is shared with no batch
  cache, so a heal in its race window leaves nothing stale (the class sweep's
  verdict in #3829).
- The extractor's `init` compiles three queries (defs, refs, imports), each
  under its own key. `ExtInit` compiles one. The abstraction is sound because
  the keys are disjoint and each behaves alike.
- A direct abort-kind error (`classifyTreeSitterWasmError` returns `abort`),
  which poisons the runtime on its first report with no budget. The model
  reaches `Aborted` only through the budget.
- `BatchBuild`'s `Aborted` branch caches a null (#3731 row B13). The branch is
  unchecked: removing it changes no verdict, because `NoCachedTransient`
  accepts any cache once the runtime is poisoned. In the code it is rare at
  best, since `loadLanguage` returns null once `wasmAborted` is set.

There is one unmodelled observation, and it is not a finding here: an
extractor owner memoizes its extractor per language for the process, so a
one-off compile trap at that init leaves that query `null` for that owner
until restart. This is #3673's recorded per-site verdict ("a trap within
budget costs that one query").

Bounds: two files, two content values, three consumers, three owners, two
rules, two rule sets, and `Budget` = 3 (the code's value). The pass configs
have at most two one-offs and one build per key in flight, and
`MergedBatchRaw` has at most one. The three #3834 batch configs
(`RaceBatchHeal`, `RaceBatchCoalesce`, `Mut3834BatchRace`) share the bounds the
race needs: two builds in flight and three one-offs. `RaceRawHeal` needs one raw
compile in flight and two one-offs. Those are the smallest bounds at which each
finding appears.

## Heal and skip sites

Each row removes one site from the spec and lists the configs whose verdict
changes. The run is `mutants.py` from #3829's round 2.

| Site (code) | Model | Configs that red when the site is removed |
|---|---|---|
| parse heal (`parseFileAndUse`, caller undefined) | `Parse`, `Clr(sr, kp, ...)` | `MergedFiles` |
| consume heal (`parseFileAndUse`, caller set) | `Parse`, `Clr(s1, kc, ...)` | `MergedFiles`, `MutF2`, `MutF4`, `ResidualR1` |
| probe heal (`compileQueryBatch`, `probeInput`) | `Probe` | `MergedBatch`, `MergedBatchRaw`, both races |
| combined heal (`compileQueryBatch`, `batchInput`) | `Combine` | `MergedBatch`, `MergedBatchRaw`, both races |
| raw heal (`compileRawQuery`) | `RawDo` | `MergedBatchRaw`, `RaceRawHeal` |
| parse skip | `Parse` | `MergedFiles`, `MutF2`, `MutF4`, `ResidualR1` |
| probe skip | `Probe` | `MergedBatch`, `MergedBatchRaw`, `ReachSkipCached`, both races |
| batch-key skip (charged null) | `BatchCheck` | `MergedBatch`, `MergedBatchRaw`, both races |
| raw skip | `RawCheck` | `MergedBatchRaw`, `RaceRawHeal` |
| aborted-build cached null (B13) | `BatchBuild` | none (see Scope) |
