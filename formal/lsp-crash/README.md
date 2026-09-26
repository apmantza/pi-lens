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
  diagnostics), `"C"` the dispatch runner's collecting touch. Each is:
  1. Acquire: `getClientForFile` → `ensureClientForServer`, which detects a
     dead client, runs the #1127/#1142 breakers and respawns, then a lease.
  2. Decide: `shouldSkipNotify` reads the `recentTouches` entry for
     (path, scope, serverId).
  3. Write: `notify.open`. A dead client resolves `true`
     (`handleNotifyOpen`'s `!isClientAlive` return, and a queued entry whose
     runner sees the dead client, read as sent by `sent !== false`).
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
- `NoEvictUnderLease`: eviction never takes a client out from under an
  in-flight touch.

## The constants that select code or mutant

- `Fix`: `"bind"` is the code since #3501: a `recentTouches` entry is valid
  only for the client instance whose write marked it. `"none"` is the code
  before #3501. `"clear"`, `"clearDeath"` and `"clearDeadFalse"` are the
  alternative fix (delete the entry on death and eviction) and its variants.
- `ClearReadyOnDeath`: `TRUE` is the code since #3502: the dead-client
  branch deletes `demonstratedReady` and `demonstratedCold` like every other
  retirement path. `FALSE` is the code before #3502.
- `ReadyGuard`: `TRUE` is the code since #3502's review round 1: a touch
  marks `demonstratedReady` only while its client is still the registered
  one. `FALSE` is the mutant where a dead client's late answer marks the key
  its replacement now holds.
- `PingGuard`, `WaitTimeout`, `LeaseCheck`, `FastPath`, `WindowTrip`: `TRUE`
  is the code; `FALSE` is a guard mutant.

## Results

| Config | Expect | Verdict | States | s |
|---|---|---|---|---|
| `CrashBetweenTouches` (code, #3501) | pass | pass | 363 | 2.5 |
| `CrashBetweenTouchesHeld` (code, #3501) | pass | pass | 363 | 2.4 |
| `CrashBetweenTouchesNonSilent` | pass | pass | 363 | 2.5 |
| `EvictBetweenTouches` (code, #3501) | pass | pass | 110 | 2.2 |
| `MutNoBindCrashBetweenTouches` (pre-#3501 code) | violated `NoFalseClean` | violated | 318 | 2.8 |
| `MutNoBindCrashBetweenTouchesHeld` (pre-#3501 code) | violated `SkipImpliesHeld` | violated | 112 | 2.2 |
| `MutNoBindEvictBetweenTouches` (pre-#3501 code) | violated `NoFalseClean` | violated | 95 | 2.7 |
| `FixBind` (code: concurrent, crash and eviction) | pass | pass | 82299 | 9.0 |
| `FixBindSeq` (code: sequential, crash and eviction) | pass | pass | 859 | 2.7 |
| `FixClearSeq` | pass | pass | 742 | 3.3 |
| `MutFixClearConcurrent` | violated `NoFalseClean` | violated | 13553 | 4.5 |
| `MutFixClearDeadFalseConcurrent` | violated `NoFalseClean` | violated | 14795 | 4.2 |
| `MutFixClearDeathOnly` | violated `NoFalseClean` | violated | 117 | 2.4 |
| `CrashMidWait` | pass | pass | 179 | 2.2 |
| `MutCrashMidWaitNoPing` | violated `NoFalseClean` | violated | 68 | 2.6 |
| `MutCrashMidWaitNoTimeout` | violated `WaitBounded` | violated | 37 | 2.0 |
| `MutEvictNoLease` | violated `NoEvictUnderLease` | violated | 14 | 2.7 |
| `EvictNoLeaseMidWait` | pass | pass | 45 | 2.0 |
| `CrashLoop` | pass | pass | 35873 | 6.8 |
| `CrashLoopNoFastPath` | pass | pass | 19397 | 5.3 |
| `MutCrashLoopNoWindow` | violated `BoundedCrashLoop` | violated | 483 | 2.8 |
| `MutCrashLoopNoBreaker` | violated `BoundedCrashLoop` | violated | 598 | 2.8 |
| `CrashReady` (code, #3502) | pass | pass | 303 | 2.3 |
| `FixCrashReady` (code, #3502, with an eviction) | pass | pass | 661 | 2.7 |
| `MutCrashReadyNoClear` (pre-#3502 code) | violated `ReadyIsCurrent` | violated | 107 | 2.4 |
| `CrashReadyConcurrent` (code, #3502 round 1) | pass | pass | 2289 | 3.4 |
| `MutCrashReadyConcurrentNoGuard` (the ready mark without its guard) | violated `ReadyIsCurrent` | violated | 829 | 2.4 |

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

## Decisions the model backs

- **Bind, not clear.** The code compares the entry's `WeakRef` to the
  touch's own client in `shouldSkipNotify`, which `shouldSkipTouch` also
  calls for each spawned server.
- **A dead client's write still resolves `true`.** Under the bind, the entry
  it marks can only match the dead instance. A new touch never acquires a dead
  instance (`ensureClientForServer` respawns), and a touch that acquired it
  before the crash skips only on it: its wait times out and its ping fails.
  Resolving `false` instead would
  not close the concurrent route (`MutFixClearDeadFalseConcurrent`), and
  `false` already means something else to its readers: `touchFile` treats it
  as a superseded write (#3481) and the rename resync treats it as a close
  still queued ahead of the re-open.

## Replay on the real code

The throwaway replays became the regression tests:

- `tests/clients/lsp/service-crash-respawn.test.ts`: the real `touchFile` and
  the real `handleNotifyOpen` queue per client over a mock connection. Crash
  after the write, before it, and with it queued; capacity eviction; a second
  non-collecting touch; the TypeScript sync confirm after a crash between
  the touches and in the middle of the wait (racing and end-of-wait); and,
  for #3502, `ensureWarmForSweep` after a crash-respawn of a ready and of a
  cold client, after a concurrent crash-respawn, and after a notify-stall
  demotion.
- `tests/clients/lsp/crash-respawn-debounce-wire.test.ts`: the real
  `createLSPClient` and `tests/fixtures/fake-lsp-server.mjs`, SIGKILLed after
  the sync touch. Before #3501 server B's trace had no `didOpen` and the touch
  was `confirmed` with no diagnostics.

## Scope

Not modelled:
- one file, one server key, primary scope only;
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
