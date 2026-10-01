# LSP crash and respawn model

A TLA+ model of an LSP server process dying, or being evicted, while touches
of one file are in flight, and of the lazy respawn that follows
(`ensureClientForServer`'s dead-client branch in `clients/lsp/index.ts`).
Every config here states its expected verdict on its first line (see
`formal/file-locks/README.md`), and the `TLA+ models` CI job checks them all.

Issues: #3501 (the touch debounce outlives its client), #3502
(`demonstratedReady` survives a crash-respawn), #3672 (`retireClient` is the
one retirement helper and drops the per-generation derived state), #3584 (the
write-timeout streak belongs to one client), #3622 (idle eviction is a
retirement path).

## What the model covers

- **A crash** of the current client generation's server, at any step. The
  client's `onClose`/`onError`/`exit` handlers make `isClientAlive()` false in
  the same tick. Nothing resolves its pending waiters early, and the registry
  entry stays until the next attach notices the death.
- **Capacity eviction** (`makeCapacityForClient`): an idle client with no
  lease is shut down and removed from the registry.
- **Idle eviction** (`scheduleIdleEviction`, widened by #3622): an idle,
  unleased `transparent` client's timer fires. `retireClient` publishes the
  cold state before the awaited teardown, so a request during the shutdown
  waits on the spawn gate.
- **Notify-stall demotion** (`demoteForNotifyStall`): the consecutive
  write-timeout streak reaches its threshold and the client is retired. The
  code also sets the key's breaker cooldown; the model leaves `Breaker`
  unchanged (see Scope).
- **The per-generation derived state** (#3672, #3584): one touch writes the
  aux-notify inflight count (`noteAuxNotifyIssued`), a drained-barrier
  latency sample (`noteAuxNotifyDrainLatency`) and a timeout strike
  (`recordNotifyWriteBackpressure`) for its client generation. `retireClient`
  drops all of them on capacity eviction, idle eviction, notify-stall
  demotion and the dead-client respawn, per kind (`ClearedKinds`).
  Registration drops the streak a second time (`forgetReadiness` at spawn,
  `RegStreak`). A replacement that reads a predecessor's value is the defect
  `DerivedIsCurrent` rejects.
- **Touches** of the one file (`LSPService.touchFile`) with the same content,
  sequential or concurrent: `"S"` is the pipeline's `lsp_sync` touch (no
  diagnostics), `"C"` the dispatch runner's collecting touch, and `"W"`
  `ensureWarmForSweep`'s warm-up touch, whose failed verdict caches the key
  cold (`demonstratedCold`). A warm-up that finds no client to ask (the key
  in its breaker cooldown) fails for the absence of a client and caches the
  key cold too (`WarmupNoClient`), #799's negative cache for a server that
  does not spawn. Each touch is:
  1. Acquire: `getClientForFile` → `ensureClientForServer`, which detects a
     dead client, runs the #1127/#1142 breakers and respawns, then a lease.
  2. Decide: `shouldSkipNotify` reads the `recentTouches` entry for
     (path, scope, serverId).
  3. Write: `notify.open`. A dead client resolves `false` since #3543 (the
     queued run finds the client dead). Before #3543 it resolved `true`.
  4. Mark: `markTouched`, after the write resolved `true`.
  5. For `"C"`: the wait, bounded by its own timeout, then the verdict. A
     silentOnClean server's timed-out silence is confirmed clean when
     `pingLiveness()` answers (the #799 gate).
- **The language server** of each generation publishes the file's
  (non-empty) diagnostics once it holds the document. The file is dirty, so
  every "clean" verdict is false.

## Invariants

- `NoFalseClean`: no touch ends with a clean verdict.
- `SkipImpliesHeld`: a touch that skipped its write on a live client skipped
  it on a client whose server holds the document. (A skip on the dead client
  itself is harmless: its wait times out and its ping fails.)
- `WaitBounded`: a waiting touch can always leave its wait.
- `BoundedCrashLoop`: fewer than `Trip` respawns follow early or mid-life
  deaths.
- `ReadyIsCurrent`: the key's `demonstratedReady` describes the client now in
  the registry.
- `ColdIsCurrent`: the key's `demonstratedCold` describes the client now in
  the registry, or the absence of one while none is registered.
- `DerivedIsCurrent`: the key's derived facts (aux inflight count, drain
  latency EWMA, write-timeout streak) describe the client now in the
  registry, or the absence of one a retirement leaves before a replacement
  spawns.
- `NoEvictUnderLease`: eviction never takes a client out from under an
  in-flight touch.

## The constants that select code or mutant

- `Fix`: `"bind"` is the code since #3501: a `recentTouches` entry is valid
  only for the client instance whose write marked it. `"none"` is the code
  before #3501. `"clear"`, `"clearDeath"` and `"clearDeadFalse"` are the
  alternative fix (delete the entry on death and eviction) and its variants.
  `"clearDeadFalse"` added a dead client's write resolving `false`; since
  #3543 every value models that, so it is now the same model as `"clear"`.
- `ClearReadyOnDeath`: `TRUE` is the code since #3502: the dead-client
  branch deletes `demonstratedReady` and `demonstratedCold` like every other
  retirement path. `FALSE` is the code before #3502.
- `ColdGuard`: `TRUE` is the code since #3502's verify round 2: a failed
  warm-up caches the key cold only while the client it judged is still the
  registered one (for a no-client verdict: while none is registered). `FALSE`
  is the mutant where the replacement is cached cold for its predecessor's
  failure.
- `RegClear`: `TRUE` is the code since #3502's verify round 3: registering a
  client forgets the key's readiness verdicts, so a cold verdict cached while
  no client existed does not pass to the first client that spawns. `FALSE` is
  that mutant.
- `ReadyGuard`: `TRUE` is the code since #3502's review round 1: a touch
  marks `demonstratedReady` only while its client is still the registered
  one. `FALSE` is the mutant where a dead client's late answer marks the key
  its replacement now holds.
- `PingGuard`, `WaitTimeout`, `LeaseCheck`, `FastPath`, `WindowTrip`: `TRUE`
  is the code; `FALSE` is a guard mutant.
- `DerivedMissPath`: `"off"` disables the per-generation derived-state
  actions (the older configs, whose verdicts do not depend on them).
  `"none"` is the code since #3672: every retirement path drops every derived
  kind. `"capacity"`, `"idle"`, `"stall"` and `"respawn"` make that one path
  miss the kinds in `DerivedMissKinds`; `"all"` makes every path miss them.
  `"pre3584"` and `"pre3672"` are the exact per-kind drop tables of those
  trees, read off `clients/lsp/index.ts` at `5be1dda35^` and `625aa8018^`:
  - pre-#3584: only `demoteForNotifyStall` dropped the streak and the aux
    backlog; nothing dropped the EWMA; registration did not drop the streak.
  - pre-#3672: `forgetReadiness` dropped the streak on every path and at
    registration (#3584); only `demoteForNotifyStall` dropped the aux
    backlog; nothing dropped the EWMA.
- `DerivedMissKinds`: the subset of `{"ewma","inflight","streak"}` a mutant
  path fails to drop (`{}` in every config that does not name a path or
  `"all"`).
- `RegStreak`: `TRUE` is the code since #3584: registering a client drops the
  write-timeout streak (`forgetReadiness`). `FALSE` is that mutant, and the
  pre-#3584 tree. The streak therefore has two defences, the path drop and
  the registration drop, and no path's streak drop is load-bearing alone:
  `DerivedStreakPathsRedundant` (every path forgets it, registration drops
  it) passes and `DerivedStreakRegRedundant` (registration forgets it, every
  path drops it) passes; `MutDerivedLeakStreak` (both forgotten) violates.
  The EWMA and the aux inflight count have only the path drop, so each
  path's drop is load-bearing for each of them (`MutDerivedLeak<Path>Ewma`,
  `MutDerivedLeak<Path>Inflight`).
- `DeriveGuard`: `TRUE` is the code for the streak
  (`recordNotifyWriteBackpressure`, #3584 (b)) and the EWMA
  (`noteAuxNotifyDrainLatency` checks the record's client): a derived write
  lands only while the touch's client is still the registered one. `FALSE`
  is `MutDeriveStale`. `noteAuxNotifyIssued` has no such check in the code
  (it is called after awaits and recreates the record for a retired client);
  the model assumes it away for the inflight count as well. Harm unproven:
  readers other than `auxNotifyWedgeBudgetMs` check the record's client.

## Source anchors (master)

The derived-state wires in `clients/lsp/index.ts`, at the lines current on
master. The symbols are authoritative; the line numbers drift.

- `notifyWriteBackpressureStreak` field: 1489
- `auxNotifyDrainLatencyEwma` field: 1505
- `auxNotifyInflight` field: 1528
- `makeCapacityForClient` (capacity eviction): 1844
- `retireClient` (the one retirement helper): 1905
- `scheduleIdleEviction` (idle eviction, #3622): 1931
- `forgetReadiness` (the streak drop): 2103
- `forgetReadiness` at registration (the streak's second drop): 4566
- `recordNotifyWriteBackpressure` (the streak, generation-checked): 2133
- `NOTIFY_BACKPRESSURE_BROKEN_AFTER` (the streak threshold): 350
- `auxNotifyWedgeBudgetMs` (reads the EWMA): 2272
- `demoteForNotifyStall` (stall demotion): 2290
- `noteAuxNotifyIssued` (the inflight count): 2357
- `noteAuxNotifyDrainLatency` (the EWMA): 2375
- `LSPService.shutdown` (clears the EWMA and inflight maps): 10291

## Results

| Config | Expect | Verdict | States | s |
|---|---|---|---|---|
| `CrashBetweenTouches` (code, #3501) | pass | pass | 371 | 3.0 |
| `CrashBetweenTouchesHeld` (code, #3501) | pass | pass | 371 | 3.6 |
| `CrashBetweenTouchesNonSilent` | pass | pass | 371 | 4.2 |
| `EvictBetweenTouches` (code, #3501) | pass | pass | 110 | 2.0 |
| `MutNoBindCrashBetweenTouches` (pre-#3501 code) | violated `NoFalseClean` | violated | 325 | 2.6 |
| `MutNoBindCrashBetweenTouchesHeld` (pre-#3501 code) | violated `SkipImpliesHeld` | violated | 157 | 2.6 |
| `MutNoBindEvictBetweenTouches` (pre-#3501 code) | violated `NoFalseClean` | violated | 124 | 3.0 |
| `FixBind` (code: concurrent, crash and eviction) | pass | pass | 81101 | 7.6 |
| `FixBindSeq` (code: sequential, crash and eviction) | pass | pass | 875 | 2.8 |
| `FixClearSeq` | pass | pass | 760 | 2.4 |
| `MutFixClearConcurrent` | violated `NoFalseClean` | violated | 11535 | 4.8 |
| `MutFixClearDeadFalseConcurrent` | violated `NoFalseClean` | violated | 16530 | 5.6 |
| `MutFixClearDeathOnly` | violated `NoFalseClean` | violated | 122 | 2.9 |
| `CrashMidWait` | pass | pass | 161 | 2.9 |
| `MutCrashMidWaitNoPing` | violated `NoFalseClean` | violated | 73 | 3.5 |
| `MutCrashMidWaitNoTimeout` | violated `WaitBounded` | violated | 30 | 4.5 |
| `MutEvictNoLease` | violated `NoEvictUnderLease` | violated | 5 | 3.5 |
| `EvictNoLeaseMidWait` | pass | pass | 42 | 1.9 |
| `CrashLoop` | pass | pass | 45393 | 11.4 |
| `CrashLoopNoFastPath` | pass | pass | 26050 | 8.6 |
| `MutCrashLoopNoWindow` | violated `BoundedCrashLoop` | violated | 233 | 3.3 |
| `MutCrashLoopNoBreaker` | violated `BoundedCrashLoop` | violated | 872 | 3.5 |
| `CrashReady` (code, #3502) | pass | pass | 293 | 2.8 |
| `FixCrashReady` (code, #3502, with an eviction) | pass | pass | 641 | 2.3 |
| `MutCrashReadyNoClear` (pre-#3502 code) | violated `ReadyIsCurrent` | violated | 114 | 3.5 |
| `CrashReadyConcurrent` (code, #3502 round 1) | pass | pass | 2172 | 3.8 |
| `MutCrashReadyConcurrentNoGuard` (the ready mark without its guard) | violated `ReadyIsCurrent` | violated | 687 | 5.4 |
| `WarmupColdConcurrent` (code, #3502 verify round 2) | pass | pass | 2174 | 3.9 |
| `MutWarmupColdNoGuard` (the cold cache without its guard) | violated `ColdIsCurrent` | violated | 799 | 3.3 |
| `WarmupColdNoClient` (code, #3502 verify round 3) | pass | pass | 249 | 3.2 |
| `MutWarmupColdNoRegClear` (registration keeps the no-client verdict) | violated `ColdIsCurrent` | violated | 184 | 3.5 |
| `DerivedCurrent` (code, #3672/#3584) | pass | pass | 7851 | 2.1 |
| `DerivedCurrentConcurrent` (code, overlapping touches) | pass | pass | 5383 | 2.3 |
| `DerivedStreakPathsRedundant` (no path drops the streak, registration does) | pass | pass | 8467 | 2.7 |
| `DerivedStreakRegRedundant` (registration keeps the streak, every path drops it) | pass | pass | 7851 | 2.3 |
| `MutDerivedLeakCapacity` (capacity drops none of the three) | violated `DerivedIsCurrent` | violated | 54 | 1.8 |
| `MutDerivedLeakCapacityEwma` (capacity keeps the EWMA) | violated `DerivedIsCurrent` | violated | 54 | 2.1 |
| `MutDerivedLeakCapacityInflight` (capacity keeps the inflight count) | violated `DerivedIsCurrent` | violated | 54 | 2.0 |
| `MutDerivedLeakIdle` (idle eviction drops none of the three) | violated `DerivedIsCurrent` | violated | 54 | 1.9 |
| `MutDerivedLeakIdleEwma` (idle eviction keeps the EWMA) | violated `DerivedIsCurrent` | violated | 54 | 1.8 |
| `MutDerivedLeakIdleInflight` (idle eviction keeps the inflight count) | violated `DerivedIsCurrent` | violated | 54 | 1.8 |
| `MutDerivedLeakStall` (stall demotion drops none of the three) | violated `DerivedIsCurrent` | violated | 54 | 2.3 |
| `MutDerivedLeakStallEwma` (stall demotion keeps the EWMA) | violated `DerivedIsCurrent` | violated | 54 | 1.9 |
| `MutDerivedLeakStallInflight` (stall demotion keeps the inflight count) | violated `DerivedIsCurrent` | violated | 54 | 2.1 |
| `MutDerivedLeakRespawn` (respawn drops none of the three) | violated `DerivedIsCurrent` | violated | 142 | 2.0 |
| `MutDerivedLeakRespawnEwma` (respawn keeps the EWMA) | violated `DerivedIsCurrent` | violated | 142 | 2.1 |
| `MutDerivedLeakRespawnInflight` (respawn keeps the inflight count) | violated `DerivedIsCurrent` | violated | 142 | 2.0 |
| `MutDerivedLeakStreak` (no path and no registration drops the streak) | violated `DerivedIsCurrent` | violated | 228 | 2.0 |
| `MutDeriveStale` (a derived write has no generation check) | violated `DerivedIsCurrent` | violated | 81 | 1.7 |
| `PreFix3672DerivedLeak` (pre-#3672 tree) | violated `DerivedIsCurrent` | violated | 232 | 3.5 |
| `PreFix3584DerivedLeak` (pre-#3584 tree) | violated `DerivedIsCurrent` | violated | 232 | 2.4 |

State counts of a violated config vary between runs: TLC stops at the first
counterexample its workers reach.

- **`MutNoBindCrashBetweenTouches`** (the #3501 trace): the sync touch
  writes to A and marks the entry, A crashes, the collecting touch respawns B,
  its Decide reads A's entry and skips the write, B's wait times out on a
  document it never received, and B's ping answers: clean.
- **`MutFixClearConcurrent`**: clearing the entry when the death is detected
  is not enough. A concurrent touch whose write to A was already in flight
  marks the entry after the clear, and the next touch skips B.
  `MutFixClearDeadFalseConcurrent` shows the same even when a dead client's
  `notify.open` resolves `false`: the write that landed before the crash
  still marks. `MutFixClearDeathOnly` leaves the eviction route open.
- **`MutCrashReadyNoClear`** (the #3502 trace): a collecting touch on A
  earns `demonstratedReady`, A crashes, the next touch respawns B, and the
  key still claims readiness for a client that has answered nothing.
- **`MutCrashReadyConcurrentNoGuard`**: the dead-client branch forgets the
  key, but a concurrent touch whose client answered and then died marks it
  ready again after the respawn. The mark is taken only for the registered
  client since #3502's review round 1.
- **`MutWarmupColdNoGuard`**: the cold twin. A warm-up on A fails because A
  dies; a concurrent touch respawns B, whose dead-client branch forgets the
  key; the warm-up then caches the key cold, and B is skipped from the cache
  on every later sweep. Since #3502's verify round 2 the cache is taken only
  for the client the warm-up judged.
- **`MutDerivedLeak<Path>`, `MutDerivedLeak<Path>Ewma` and
  `MutDerivedLeak<Path>Inflight`**: one touch writes the three derived facts,
  then the named retirement path retires the client without dropping all of
  them (the bare name), or all but the EWMA, or all but the inflight count,
  and the next touch spawns a replacement. The retained fact still names the
  old generation, so `DerivedIsCurrent` is false. The four paths are capacity
  eviction, idle eviction, notify-stall demotion and the dead-client respawn.
  Each path's drop is load-bearing for the EWMA and for the inflight count.
  The bare-name mutants also leak the streak, but registration drops it
  again, so their red comes from the other two kinds.
- **The streak** has two defences, the path drop and the registration drop.
  `DerivedStreakPathsRedundant` and `DerivedStreakRegRedundant` each remove
  one and still pass; `MutDerivedLeakStreak` removes both and violates
  (#3584's defect). So no path's streak drop is load-bearing on its own,
  and the model does not say otherwise.
- **`PreFix3584DerivedLeak` and `PreFix3672DerivedLeak`**: the exact drop
  tables of the trees before #3584 and before #3672 (`DerivedMissPath`
  above). Both violate: the first leaks everything on capacity, idle and
  respawn, the second still leaks the EWMA and the inflight count.
- **`MutDeriveStale`**: a touch whose client was demoted writes its derived
  facts after the retirement (no `DeriveGuard`), and the replacement spawns
  over them. The code has that check for the streak since #3584 (b).
  `DerivedCurrentConcurrent` pins the guard under overlapping touches.
- **`MutWarmupColdNoRegClear`**: a warm-up finds the key in its breaker
  cooldown and caches it cold with no client; after the cooldown a touch
  spawns a client, which keeps the cached verdict and is skipped from the
  cache without a warm-up. Since #3502's verify round 3 registration forgets
  it (`WarmupColdNoClient` passes).

## Decisions the model backs

- **Bind, not clear.** The code compares the entry's `WeakRef` to the
  touch's own client in `shouldSkipNotify`, which `shouldSkipTouch` also
  calls for each spawned server.

## A decision the model is indifferent to

- **A dead client's write resolves `false` (#3543).** `Write` models it, but
  no verdict depends on it: with `Write` set back to #3501's `true`, all 31
  configs keep their verdicts. So `"clearDeadFalse"` is now the same model
  as `"clear"`. #3501 kept `true` because, under the bind, the entry a dead
  write marks can only match the dead instance. That covers the debounce
  entry, which is per client. The drift record is per file, not per client:
  `touchFile` stamps it when every targeted write resolved `true`, so a dead
  client's `true` told the drift sweep a respawned server's view was in sync.
  The decision rests on the tests, not on this model:
  - `tests/clients/lsp/notify-read-order.test.ts`: `writes no debounce entry
    or drift record for a touch on a dead client`, and `writes no debounce
    entry or drift record for a queued touch the client died under`.
  - `waiterTruth` in `tests/clients/lsp/notify-queue-properties.test.ts`.

  Its readers: `touchFile` files the server under `supersededServerIds` and
  stamps neither record. The rename resync counts the re-open as failed and
  names the dead client in its reason.

## Replay on the real code

The throwaway replays became the regression tests:

- `tests/clients/lsp/service-crash-respawn.test.ts`: the real `touchFile` and
  the real `handleNotifyOpen` queue per client over a mock connection. Crash
  after the write, before it, and with it queued; capacity eviction; a second
  non-collecting touch; the TypeScript sync confirm after a crash between
  the touches and in the middle of the wait (racing and end-of-wait); and,
  for #3502, `ensureWarmForSweep` after a crash-respawn of a ready and of a
  cold client, after a concurrent crash-respawn (ready mark and cold
  cache), after a notify-stall demotion, and after capacity and idle
  eviction.
- `tests/clients/lsp/crash-respawn-debounce-wire.test.ts`: the real
  `createLSPClient` and `tests/fixtures/fake-lsp-server.mjs`, SIGKILLed after
  the sync touch. Before #3501 server B's trace had no `didOpen` and the touch
  was `confirmed` with no diagnostics.

## Scope

Not modelled:
- one file, one server key, primary scope only;
- the three derived facts are written by one action (`Derive`) rather than at
  their real write points (notify issue, drained barrier, timeout); only their
  generation and their retirement are modelled. `Derive` makes the streak
  present after one write, where the code needs `NOTIFY_BACKPRESSURE_BROKEN_AFTER`
  (3) consecutive timeouts, and `StallDemote` needs only that streak: an
  over-approximation;
- `DeriveGuard = TRUE` assumes every derived write is generation-checked.
  `noteAuxNotifyIssued` is not: it has no registry check and runs after
  awaits, so a retired client's late issue can recreate its inflight record.
  Harm unproven (no reachable interleaving found in review where the stale
  record prices a live replacement's wedge window);
- the healthy-write streak clear, the late-landing retract and `paceAuxNotify`'s
  record deletes: they only remove facts, so omitting them is conservative;
- `LSPService.shutdown()` (the session reset): it clears the EWMA and inflight
  maps wholesale but not the streak, which only the registration drop then
  removes;
- `StallDemote` does not set the key's breaker cooldown (`state.broken`, as
  the code does), so the model's replacement may spawn at once, which is
  conservative;
- the warm-up's retry: a `"W"` touch is one attempt, and its verdict is that
  attempt's (the code snapshots the registered client after attempt 1 and
  checks it after the retry). The no-client verdict is reached only from the
  breaker cooldown, not from a spawn that throws;
- time (the debounce window and the breaker windows are over-approximated);
- the TypeScript sync confirm (#707). It asked the registry's client for the
  file rather than the touch's own client. After a crash in the middle of the
  wait, a replacement whose project a concurrent touch had loaded answered
  from the file on disk without ever being sent the touch's content: a
  confirmed clean for a dirty buffer (replayed on the real service in review
  round 1). Since then the confirm is asked of the touch's own client
  (`tsserverSyncChannel`), and a dead one does not execute. The tests cover
  both the racing and the end-of-wait confirm.

The concurrent-clear counterexample was not replayed on the real code.
