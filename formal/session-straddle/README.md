# Session straddle model

A TLA+ model of session-scoped runtime state (the cascade carry-over) across a
same-process session replacement, and of the #2890 duplicate-start gate. Every
config here states its expected verdict on its first line (see
`formal/file-locks/README.md`), and the `TLA+ models` CI job
(`node scripts/check-tla-models.mjs`) checks them all.

Issue: #3499.

## What the model covers

- **Replacement in the same cwd** (`/new`, fork, or resume into the same
  cwd). pi caches the extension module per cwd (`loader.js`
  `loadExtensionModule`, `useExtensionCacheCwd`), so the module-level
  `runtime` (`index.ts:566`) is one object for both sessions.
- **session_start, split at its awaits.**
  1. The admission key is set first (`index.ts:2077`).
  2. The pre-handler resets run.
  3. Then it awaits `configureWarmAttach` and `ensureLSPConfigInitialized`.
  4. Only then do the generation bump and the cascade clear run, in
     `handleSessionStart -> runtime.resetForSession`
     (`runtime-session.ts:2408`, `runtime-coordinator.ts:434-443`).
- **The session-1 quiet window.** It is fire-and-forget from `agent_settled`
  (`index.ts:3568`). `runQuietWindow` captures the session generation when
  the window starts (`quiet-window.ts:162`) and runs its tasks in sequence:
  - `cascade_carry_over_settle` (`quiet-window.ts:226`) calls
    `settleCascadeRuns`. That takes `_pendingCascadeRuns`, awaits up to
    `PI_LENS_QUIET_WINDOW_WAIT_MS` (15 s), then appends the settled runs and
    re-parks the rest (`runtime-coordinator.ts:1025-1092`).
  - The cascade-tier reconcile (`cascade-tier.ts:479`) calls
    `onResolvedFound`, which appends a run after the reconcile's own await
    (`index.ts:3380-3389`).
- **Session 2's turn_end** consumes and delivers
  (`runtime-turn.ts:1147`). Its supersede filter is
  `getFilesChangedSince(origin.projectSeq)`. `projectSeq` restarts at the
  reset, so a session-1 run is never superseded.
- **The duplicate session_start** (#2890). pi RPC awaits `rebindSession`
  twice. The gate suppresses an identical `(reason, session id)` unless the
  live tool plan changed (`index.ts:2057-2077`).

`FixParts` selects which quiet-window writes drop when the captured
generation is no longer current. `{"settle","reconcile"}` is the shipped code;
`{}` is the code before #3499.

## Invariants

- `NoCrossSessionState`: after session 2's reset, no session-1 run or parked
  compute is in the runtime. This is the promise "Session reset still clears
  it" (`runtime-coordinator.ts:615-616`).
- `NoCrossSessionDelivery`: a run computed in session 1 is never delivered by
  session 2's turn_end.
- `OneResetPerSession`: one `session_start` mutation pass per session.

## Results

| Config | Expect | States |
|---|---|---|
| `StraddleState` (shipped code) | pass | 59 |
| `StraddleDelivery` (shipped code) | pass | 59 |
| `NoQuietWindow` (nothing in flight at the replacement) | pass | 10 |
| `NoQuietWindowNoResetClear` (guard mutant: no reset clear) | violated `NoCrossSessionState` | 8 |
| `FixSettleOnly` (fix mutant: only the settle is guarded) | violated `NoCrossSessionState` | 58 |
| `FixReconcileOnly` (fix mutant: only the reconcile is guarded) | violated `NoCrossSessionState` | 40 |
| `FixReconcileLateCapture` (fix mutant: reconcile captures at task start) | violated `NoCrossSessionState` | 62 |
| `FixNoResetClear` (guard mutant of the shipped code) | violated `NoCrossSessionState` | 21 |
| `DuplicateStart` | pass | 93 |
| `DuplicateStartNoDedupe` (guard mutant: no #2890 gate) | violated `OneResetPerSession` | 35 |
| `DuplicateStartToolDrift` (documented, see below) | violated `OneResetPerSession` | 35 |

Before #3499, `StraddleState` violated `NoCrossSessionState` and
`StraddleDelivery` violated `NoCrossSessionDelivery`. The delivery
counterexample:

1. Session 1 has a parked cascade compute.
2. `agent_settled` starts the quiet window, and the settle takes the pending
   list.
3. `session_shutdown`, then session 2's `session_start` and `resetForSession`
   (generation 1 -> 2; runs and pending cleared).
4. The compute resolves, and the settle appends it to `_cascadeRuns`.
5. Session 2's first turn_end consumes it and delivers it.

Each fix part is needed: `FixSettleOnly` and `FixReconcileOnly` each go red.
`FixReconcileLateCapture` shows the generation must be captured when the
window starts, not when the reconcile task starts, because that task starts
only after a settle that can take 15 s. The reset's own clear is still needed
for state parked before the replacement (`FixNoResetClear`).

## Replay on the real code

`tests/clients/quiet-window-session-straddle.test.ts` replays the
counterexamples on the built `RuntimeCoordinator`, the built-in quiet-window
tasks, the tier-3 reconcile task and `runQuietWindow`, with gates and fake
timers. One case per config: the settle append (`StraddleDelivery`), the
re-park (`StraddleState`), the reconcile append (`FixSettleOnly`), a late
capture (`FixReconcileLateCapture`), and the same-session control. Each
replacement case was red before #3499.

## Scope

Not modelled:

- time. The settle cap and delays are over-approximated;
- the tier-3 outstanding-touch registry. `handleSessionStart` clears it
  (`resetCascadeTierSessionState`, `runtime-session.ts:2407`) in the same
  tick as the generation bump. So a reconcile that starts after the reset
  finds only touches recorded after it. Those are either session 2's own, or
  strays that a still-running session-1 cascade compute records
  (`clients/dispatch/integration.ts`, `recordOutstandingCascadeTouch`). The
  stray is the real-code form of `FixReconcileLateCapture`, and the replay
  test drives it. Two consequences sit outside this model. A stale
  session-1 reconcile drops session 2's own touches along with the strays.
  A stray that no stale window drains is still delivered by session 2's own
  quiet window, because a touch carries no generation;
- the pre-handler resets in `index.ts` (latency brackets, telemetry,
  once-per-session phases) against late session-1 writers;
- the cross-cwd replacement. There the module is re-evaluated and the old
  `runtime` is a different object, so this straddle cannot occur;
- tool_result pipelines still running at the replacement. pi's
  `teardownCurrent` awaits `session.abort()` first.

## Duplicate start (#2890)

The gate holds for an identical duplicate (`DuplicateStart`), and it is not
vacuous (`DuplicateStartNoDedupe`).

`DuplicateStartToolDrift` is the #2895 design. A duplicate whose live tool set
drifted re-runs the *whole* mutation pass, including `resetForSession` and a
generation bump. `tests/index-integration.test.ts` pins two
`session_start_runtime_reset` rows. AGENTS.md describes this as re-entering
"the restore path". It is recorded here as a model finding, not as a bug.
