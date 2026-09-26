# Session straddle model

A TLA+ model of session-scoped runtime state across a same-process session
replacement: the cascade carry-over and the tier-3 touch registry. It also
models the #2890 duplicate-start gate. Every config here states its expected
verdict on its first line (see `formal/file-locks/README.md`), and the
`TLA+ models` CI job (`node scripts/check-tla-models.mjs`) checks them all.

Issues: #3499 (the quiet-window fix), #3512 (the overflow admission path and
session-1 strays).

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
  (`index.ts:3568`). `runQuietWindow` runs its tasks in sequence and captures
  the session generation as each task starts (`quiet-window.ts:174`), at the
  same instant the task snapshots its state:
  - `cascade_carry_over_settle` (`quiet-window.ts:225`) calls
    `settleCascadeRuns`. That takes `_pendingCascadeRuns`, awaits up to
    `PI_LENS_QUIET_WINDOW_WAIT_MS` (15 s), then appends the settled runs and
    re-parks the rest (`runtime-coordinator.ts:1025-1092`).
  - The cascade-tier reconcile (`cascade-tier.ts:479`) drains the touch
    registry synchronously, awaits per entry, then calls `onResolvedFound`,
    which appends a run (`index.ts:3380-3389`).
- **The overflow admission path** (`Overflow`, #3512). Past 32 unsettled
  computes, `appendCascadePromise` appends a settled run from a detached
  `.then` (`runtime-coordinator.ts:994-998`) that the reset cannot reach. It
  captures the session generation at admission and appends through
  `guardedWrite`. Under `Overflow` the session-1 compute takes this path, and
  session 2 admits one of its own past the cap (`Admit2`, `Resolve2`).
- **Session 2's own tier-3 touches**, split into the dispatch, which captures
  the generation (`runtime-tool-result.ts:904`), and the record
  (`integration.ts:2045`). Session 2's own quiet window reconciles them. That
  window cannot start while session 1's is still in progress
  (`_inProgress`).
- **Session 2's turn_end** consumes and delivers
  (`runtime-turn.ts:1147`). Its supersede filter is
  `getFilesChangedSince(origin.projectSeq)`. `projectSeq` restarts at the
  reset, so a session-1 run is never superseded.
- **Strays** (`Strays`, #3512). A still-running session-1 cascade compute
  records a touch after the reset (`clients/dispatch/integration.ts`,
  `recordOutstandingCascadeTouch`). The compute carries the generation its
  dispatch captured in session 1, and the record site drops the touch through
  it.
- **The duplicate session_start** (#2890). pi RPC awaits `rebindSession`
  twice. The gate suppresses an identical `(reason, session id)` unless the
  live tool plan changed (`index.ts:2057-2077`).

`FixParts` selects the guards:

- `settle`: the settle's append and re-park drop on a stale generation.
- `reconcile`: the reconcile's append drops on a stale generation.
- `reconcileTaskCapture`: the reconcile captures when its task starts, where
  it drains. Without it, the reconcile captures when the window starts, as
  review rounds 0 and 1 did.
- `reconcileStart`: the round-1 design. The reconcile stands down before its
  drain when its captured generation is stale.
- `admission` (#3512): the overflow append drops on a stale generation
  captured at admission.
- `stray` (#3512): the tier-3 touch record drops on a stale generation
  captured when the dispatch started.
- Mutants of the #3512 captures: `admissionHoist` and `dispatchHoist` reuse
  session 1's handle for later admissions or dispatches; `strayRecordCapture`
  stamps a touch with the generation current when it is recorded.

The shipped code is
`{"settle","reconcile","reconcileTaskCapture","admission","stray"}`, and `{}`
is the code before #3499.

## Invariants

- `NoCrossSessionState`: after session 2's reset, no session-1 run or parked
  compute is in the runtime. This is the promise "Session reset still clears
  it" (`runtime-coordinator.ts:615-616`).
- `NoCrossSessionDelivery`: a run computed in session 1 is never delivered by
  session 2's turn_end.
- `NoDropFreshTouch`: no guard drops session 2's own tier-3 touch (catalog
  shape 54, the no-drop direction).
- `NoDropFreshAdmission`: the admission guard never drops a compute session 2
  admits past the cap (shape 54, #3512).
- `OneResetPerSession`: one `session_start` mutation pass per session.

## Results

Distinct states as TLC reports them with one worker; a violated config stops
at its first counterexample.

| Config | Expect | States |
|---|---|---|
| `StraddleState` (shipped code) | pass | 171 |
| `StraddleDelivery` (shipped code) | pass | 171 |
| `StrayTouch` (shipped code with strays, #3512) | pass | 283 |
| `OverflowAdmission` (shipped code, overflow and strays, #3512) | pass | 1234 |
| `FixNoStartCheck` (window-start capture, the round-0 code) | violated `NoDropFreshTouch` | 125 |
| `FixWindowCaptureStartCheck` (round-1 design, see below) | pass | 135 |
| `FixSettleOnly` (only the settle is guarded) | violated `NoCrossSessionState` | 75 |
| `FixReconcileOnly` (only the reconcile is guarded) | violated `NoCrossSessionState` | 42 |
| `FixNoResetClear` (guard mutant of the shipped code) | violated `NoCrossSessionState` | 17 |
| `FixNoAdmissionGuard` (the overflow append unguarded, #3512) | violated `NoCrossSessionDelivery` | 46 |
| `FixAdmissionHoist` (one admission handle reused, #3512) | violated `NoDropFreshAdmission` | 50 |
| `FixNoStrayGuard` (the touch record unguarded, #3512) | violated `NoCrossSessionDelivery` | 81 |
| `FixStrayRecordCapture` (stamped at record time, #3512) | violated `NoCrossSessionDelivery` | 81 |
| `FixDispatchHoist` (one dispatch handle reused, #3512) | violated `NoDropFreshTouch` | 48 |
| `StrayToolDrift` (documented, see below) | violated `NoDropFreshTouch` | 77 |
| `NoQuietWindow` (nothing in flight at the replacement) | pass | 26 |
| `NoQuietWindowNoResetClear` (guard mutant: no reset clear) | violated `NoCrossSessionState` | 7 |
| `DuplicateStart` | pass | 243 |
| `DuplicateStartNoDedupe` (guard mutant: no #2890 gate) | violated `OneResetPerSession` | 28 |
| `DuplicateStartToolDrift` (documented, see below) | violated `OneResetPerSession` | 28 |

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

- The settle guard and the reconcile guard are each needed
  (`FixSettleOnly`, `FixReconcileOnly`).
- The reconcile must capture where it drains (`FixNoStartCheck`). A generation
  guard is captured at the instant the guarded state is snapshotted. The
  settle snapshots at its task start, which is window start. The reconcile
  drains at its own task start, up to about 17 s later, and the reset empties
  the registry in the same tick as the bump. A window-start capture therefore
  sees a stale generation on a drain that holds only touches recorded since
  the reset, and its append guard drops session 2's own.
- The reset's own clear is still needed for state parked before the
  replacement (`FixNoResetClear`).
- Strays need a generation captured when the dispatch starts (`StrayTouch`
  against `FixNoStrayGuard`). A stray is recorded after the reset, as session
  2's own touch is, so stamping it at record time reads session 2's
  generation and it is still delivered (`FixStrayRecordCapture`). Before
  #3512, `StrayTouch` violated `NoCrossSessionDelivery`.
- The overflow append needs its own guard (`FixNoAdmissionGuard`): the reset
  clears `_cascadeRuns` and `_pendingCascadeRuns`, but not a detached `.then`.
- Each #3512 capture is per admission and per dispatch. A handle reused from
  session 1 drops session 2's own compute or touch (`FixAdmissionHoist`,
  `FixDispatchHoist`), so both no-drop invariants can fail.

What the model cannot see: it has no clock. `FixWindowCaptureStartCheck`, the
round-1 design, passes every invariant here, yet it cost real behaviour. A
stale window stood down and left session 2's touch for session 2's next
window. That window can be a whole prompt away, because session 2's first
`agent_settled` window is skipped while the stale one is in progress. A touch
older than `OUTSTANDING_TOUCH_MAX_AGE_MS` (15 minutes) then expires
unanswered. The replay test pins this with fake timers; the model does not.

## Replay on the real code

`tests/clients/quiet-window-session-straddle.test.ts` replays the
counterexamples on the built `RuntimeCoordinator`, the built-in quiet-window
tasks, the tier-3 reconcile task and `runQuietWindow`, with gates and fake
timers:

- the settle append (`StraddleDelivery`);
- the re-park (`StraddleState`);
- the reconcile append after a reset during its awaits (`FixSettleOnly`);
- a touch recorded after the reset, which the stale window's reconcile
  delivers for session 2 even when session 2's next window is 16 minutes
  later (`FixNoStartCheck`, and the round-1 design's clock-only cost);
- the same-session control;
- the overflow admission path: 33 gated computes, a replacement, then
  compute #33 resolves, beside a compute session 2 admits past the cap
  (`OverflowAdmission`, `FixNoAdmissionGuard`, `FixAdmissionHoist`);
- a stray and session 2's own touch, both recorded after the reset by the
  real `computeCascadeForFile` (`StrayTouch`, `FixNoStrayGuard`,
  `FixDispatchHoist`).

`tests/clients/runtime-tool-result.test.ts` pins where the dispatch
generation is captured (per dispatch, at dispatch: `FixStrayRecordCapture`,
`FixDispatchHoist`), and `tests/clients/pipeline.test.ts` pins that the
pipeline hands it to the compute.

## Scope

Not modelled:

- time. The settle cap, the delays and the 15-minute touch expiry are not
  modelled (see "What the model cannot see");
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

`StrayToolDrift` is the same bump seen by the #3512 guards. A session-2
dispatch that started before the drifted duplicate has its touch dropped at
the record, and a session-2 overflow admission would drop the same way. The
reset already clears session 2's parked computes and recorded touches, so the
guards make the detached paths agree with it. Whether the host can dispatch
a tool_result between the two `session_start` events is not established
here; this is recorded as a model finding, not as a bug.
