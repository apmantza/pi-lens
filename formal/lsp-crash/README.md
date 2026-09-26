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
- `ClearReadyOnDeath`: `FALSE` is the code; `TRUE` is the #3502 fix.
- `PingGuard`, `WaitTimeout`, `LeaseCheck`, `FastPath`, `WindowTrip`: `TRUE`
  is the code; `FALSE` is a guard mutant.

## Results

| Config | Expect | Verdict | States | s |
|---|---|---|---|---|
| `CrashBetweenTouches` (code, #3501) | pass | pass | 363 | 2.0 |
| `CrashBetweenTouchesHeld` (code, #3501) | pass | pass | 363 | 1.9 |
| `CrashBetweenTouchesNonSilent` | pass | pass | 363 | 2.0 |
| `EvictBetweenTouches` (code, #3501) | pass | pass | 110 | 1.6 |
| `MutNoBindCrashBetweenTouches` (pre-#3501 code) | violated `NoFalseClean` | violated | 347 | 1.8 |
| `MutNoBindCrashBetweenTouchesHeld` (pre-#3501 code) | violated `SkipImpliesHeld` | violated | 76 | 1.7 |
| `MutNoBindEvictBetweenTouches` (pre-#3501 code) | violated `NoFalseClean` | violated | 113 | 1.9 |
| `FixBind` (code: concurrent, crash and eviction) | pass | pass | 80029 | 5.0 |
| `FixBindSeq` (code: sequential, crash and eviction) | pass | pass | 859 | 1.6 |
| `FixClearSeq` | pass | pass | 742 | 2.2 |
| `MutFixClearConcurrent` | violated `NoFalseClean` | violated | 13941 | 2.8 |
| `MutFixClearDeadFalseConcurrent` | violated `NoFalseClean` | violated | 16609 | 3.0 |
| `MutFixClearDeathOnly` | violated `NoFalseClean` | violated | 122 | 1.8 |
| `CrashMidWait` | pass | pass | 179 | 1.7 |
| `MutCrashMidWaitNoPing` | violated `NoFalseClean` | violated | 78 | 1.9 |
| `MutCrashMidWaitNoTimeout` | violated `WaitBounded` | violated | 35 | 1.9 |
| `MutEvictNoLease` | violated `NoEvictUnderLease` | violated | 14 | 1.7 |
| `EvictNoLeaseMidWait` | pass | pass | 45 | 1.8 |
| `CrashLoop` | pass | pass | 35873 | 3.6 |
| `CrashLoopNoFastPath` | pass | pass | 19397 | 3.0 |
| `MutCrashLoopNoWindow` | violated `BoundedCrashLoop` | violated | 431 | 2.1 |
| `MutCrashLoopNoBreaker` | violated `BoundedCrashLoop` | violated | 337 | 1.8 |
| `CrashReady` (code, #3502 open) | violated `ReadyIsCurrent` | violated | 161 | 1.9 |
| `FixCrashReady` | pass | pass | 661 | 1.7 |

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
  non-collecting touch; and the TypeScript sync-confirm route.
- `tests/clients/lsp/crash-respawn-debounce-wire.test.ts`: the real
  `createLSPClient` and `tests/fixtures/fake-lsp-server.mjs`, SIGKILLed after
  the sync touch. Before #3501 server B's trace had no `didOpen` and the touch
  was `confirmed` with no diagnostics.

## Scope

Not modelled:
- one file, one server key, primary scope only;
- time (the debounce window and the breaker windows are over-approximated);
- the TypeScript sync confirm (#707). It asks the registry's client for the
  file, not the touch's own client. Before #3501 the crash-between-touches
  route sent that question to a replacement that held no document, which
  tsserver rejects ("No Project."), so the touch ended inconclusive; the bind
  now sends the replacement the document first. The route the bind does not
  touch is a crash in the middle of the wait: the confirm then respawns a
  server the touch never wrote to. A fresh tsserver rejects it the same way;
  one whose project another file has already loaded would answer from the
  file on disk rather than from the touch's content (not replayed).

The concurrent-clear counterexample was not replayed on the real code.
