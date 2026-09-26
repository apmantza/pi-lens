# LSP crash and respawn model

A TLA+ model of an LSP server process dying, or being evicted, while touches
of one file are in flight, and of the lazy respawn that follows
(`ensureClientForServer`'s dead-client branch in `clients/lsp/index.ts`).
Every config here states its expected verdict on its first line (see
`formal/file-locks/README.md`), and the `TLA+ models` CI job checks them all.

Issues: #3501 (the touch debounce outlives its client), #3502
(`demonstratedReady` survives a crash-respawn).

## What the model covers

- **A crash** of the current client generation's server, at any step. The
  client's `onClose`/`onError`/`exit` handlers make `isClientAlive()` false in
  the same tick. Nothing resolves its pending waiters early, and the registry
  entry stays until the next attach notices the death.
- **Capacity eviction** (`makeCapacityForClient`): an idle client with no
  lease is shut down and removed from the registry.
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
