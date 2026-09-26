# Session straddle model

A TLA+ model of session-scoped runtime state across a same-process session
replacement: the cascade carry-over and the tier-3 touch registry. It also
models the #2890 duplicate-start gate. Every config here states its expected
verdict on its first line (see `formal/file-locks/README.md`), and the
`TLA+ models` CI job (`node scripts/check-tla-models.mjs`) checks them all.

Issues: #3499 (the fix), #3512 (the residual).

## What the model covers

- **Replacement in the same cwd** (`/new`, fork, or resume into the same
  cwd). pi caches the extension module per cwd (`loader.js`
  `loadExtensionModule`, `useExtensionCacheCwd`), so the module-level
  `runtime` (`index.ts:566`) is one object for both sessions.
- **session_start, split at its awaits.**
  1. The admission key is set first (`index.ts:2077`).
  2. The pre-handler resets run.
  3. Then it awaits `configureWarmAttach` and `ensureLSPConfigInitialized`.
  4. Only then does `handleSessionStart` clear the tier-3 touch registry and
     bump the generation, in one tick (`runtime-session.ts:2407-2408`). The
     bump also clears the cascade state (`runtime-coordinator.ts:434-443`).
- **The session-1 quiet window.** It is fire-and-forget from `agent_settled`
  (`index.ts:3568`). `runQuietWindow` captures the session generation when
  the window starts (`quiet-window.ts:162`) and runs its tasks in sequence:
  - `cascade_carry_over_settle` (`quiet-window.ts:226`) calls
    `settleCascadeRuns`. That takes `_pendingCascadeRuns`, awaits up to
    `PI_LENS_QUIET_WINDOW_WAIT_MS` (15 s), then appends the settled runs and
    re-parks the rest (`runtime-coordinator.ts:1025-1092`).
  - The cascade-tier reconcile (`cascade-tier.ts:479`) drains the touch
    registry synchronously, awaits per entry, then calls `onResolvedFound`,
    which appends a run (`index.ts:3380-3389`).
- **Session 2's own tier-3 touches**, and session 2's own quiet window. That
  window cannot start while session 1's is still in progress
  (`_inProgress`).
- **Session 2's turn_end** consumes and delivers
  (`runtime-turn.ts:1147`). Its supersede filter is
  `getFilesChangedSince(origin.projectSeq)`. `projectSeq` restarts at the
  reset, so a session-1 run is never superseded.
- **Strays** (`Strays`, #3512). A still-running session-1 cascade compute
  records a touch after the reset (`clients/dispatch/integration.ts`,
  `recordOutstandingCascadeTouch`).
- **The duplicate session_start** (#2890). pi RPC awaits `rebindSession`
  twice. The gate suppresses an identical `(reason, session id)` unless the
  live tool plan changed (`index.ts:2057-2077`).

`FixParts` selects the #3499 guards:

- `settle`: the settle's append and re-park drop on a stale generation.
- `reconcile`: the reconcile's append drops on a stale generation.
- `reconcileStart`: the reconcile stands down before its drain when the
  window's generation is stale, leaving the registry for the current session.
- `reconcileLate`: the reconcile captures when its task starts, not when the
  window starts.

The shipped code is `{"settle","reconcile","reconcileStart"}`, and `{}` is the
code before #3499.

## Invariants

- `NoCrossSessionState`: after session 2's reset, no session-1 run or parked
  compute is in the runtime. This is the promise "Session reset still clears
  it" (`runtime-coordinator.ts:615-616`).
- `NoCrossSessionDelivery`: a run computed in session 1 is never delivered by
  session 2's turn_end.
- `NoDropFreshTouch`: no guard drops session 2's own tier-3 touch (catalog
  shape 54, the no-drop direction).
- `OneResetPerSession`: one `session_start` mutation pass per session.

## Results

| Config | Expect | States |
|---|---|---|
| `StraddleState` (shipped code) | pass | 111 |
| `StraddleDelivery` (shipped code) | pass | 111 |
| `FixNoStartCheck` (round-1 code: no start check) | violated `NoDropFreshTouch` | 106 |
| `FixSettleOnly` (only the settle is guarded) | violated `NoCrossSessionState` | 88 |
| `FixReconcileOnly` (only the reconcile is guarded) | violated `NoCrossSessionState` | 46 |
| `FixReconcileLateCapture` (reconcile captures at task start) | pass | 139 |
| `FixNoResetClear` (guard mutant of the shipped code) | violated `NoCrossSessionState` | 31 |
| `StrayTouch` (shipped code with strays, #3512) | violated `NoCrossSessionDelivery` | 100 |
| `NoQuietWindow` (nothing in flight at the replacement) | pass | 22 |
| `NoQuietWindowNoResetClear` (guard mutant: no reset clear) | violated `NoCrossSessionState` | 8 |
| `DuplicateStart` | pass | 191 |
| `DuplicateStartNoDedupe` (guard mutant: no #2890 gate) | violated `OneResetPerSession` | 36 |
| `DuplicateStartToolDrift` (documented, see below) | violated `OneResetPerSession` | 32 |

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

What each config proves:

- The settle guard and the reconcile guards are each needed
  (`FixSettleOnly`, `FixReconcileOnly`).
- The start check is needed (`FixNoStartCheck`, the #3499 round-1 code). The
  reset empties the registry, so a stale reconcile that starts after it
  drains only touches recorded since, and without the check its append guard
  drops session 2's own.
- The reset's own clear is still needed for state parked before the
  replacement (`FixNoResetClear`).
- The capture point is not load-bearing for the reconcile
  (`FixReconcileLateCapture` passes). Because the reset clears the registry in
  the same tick as the bump, a reconcile that captures at task start drains
  only the current session's touches and may deliver them itself. The
  shipped code captures once per window, and its start check hands those
  touches to the current session's own window instead. Both designs satisfy
  every invariant here. (An earlier version of this model had no touch
  registry and reported this config as violated.)
- Strays remain (`StrayTouch`). The code cannot tell a session-1 stray from
  session 2's own touch, so session 2's window delivers it. #3512 tracks
  separating them, which needs a generation captured when the dispatch
  starts.

## Replay on the real code

`tests/clients/quiet-window-session-straddle.test.ts` replays the
counterexamples on the built `RuntimeCoordinator`, the built-in quiet-window
tasks, the tier-3 reconcile task and `runQuietWindow`, with gates and fake
timers:

- the settle append (`StraddleDelivery`);
- the re-park (`StraddleState`);
- the reconcile append after a reset during its awaits (`FixSettleOnly`);
- a touch recorded after the reset, which is left for session 2's own window
  and delivered there (`FixNoStartCheck`);
- the same-session control.

## Scope

Not modelled:

- time. The settle cap and delays are over-approximated;
- the overflow admission path in `appendCascadePromise` (more than 32
  unsettled computes), tracked in #3512;
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
