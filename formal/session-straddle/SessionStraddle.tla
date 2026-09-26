--------------------------- MODULE SessionStraddle ---------------------------
(***************************************************************************)
(* Session-scoped runtime state across a same-process session replacement *)
(* (pi's /new or /resume in the same cwd: the extension module is cached,  *)
(* so the module-level `runtime` (index.ts:566) is shared by both          *)
(* sessions).                                                              *)
(*                                                                         *)
(* Actors:                                                                 *)
(*  - the host: session 1's agent_settled, session_shutdown, session 2's   *)
(*    session_start (split at its awaits: the #2890 admission key is set   *)
(*    first, index.ts:2077; the generation bump and the clear of           *)
(*    _cascadeRuns/_pendingCascadeRuns happen later, in                    *)
(*    handleSessionStart -> runtime.resetForSession,                       *)
(*    runtime-session.ts:2408, runtime-coordinator.ts:434-443), a          *)
(*    duplicate session_start for the same (reason, id) (#2890), and       *)
(*    session 2's turn_end, which consumes and delivers the cascade runs   *)
(*    (consumeCascadeRuns, runtime-turn.ts:1147);                          *)
(*  - a session-1 cascade compute parked by appendCascadePromise           *)
(*    (runtime-coordinator.ts:978), resolving at any time;                 *)
(*  - session 1's quiet window, fire-and-forget from agent_settled         *)
(*    (index.ts:3568). runQuietWindow captures the session generation      *)
(*    when the window starts (quiet-window.ts:162, #3499) and runs its     *)
(*    tasks in sequence: "cascade_carry_over_settle" (quiet-window.ts:226) *)
(*    runs settleCascadeRuns, which takes the pending list, awaits up to   *)
(*    15 s, then appends the settled runs and re-parks the rest            *)
(*    (runtime-coordinator.ts:1025-1092); then the cascade-tier reconcile  *)
(*    (cascade-tier.ts:479), whose onResolvedFound appends a run after its *)
(*    own await (index.ts:3380-3389). The reconcile drains the tier-3      *)
(*    touch registry, which the reset clears in the same tick as the       *)
(*    generation bump (runtime-session.ts:2407-2408).                      *)
(*  - session 2's cascade lane, which records its own tier-3 touch, and    *)
(*    session 2's own quiet window, which reconciles it;                   *)
(*  - optionally (Strays, #3512), the still-running session-1 compute,     *)
(*    which records a touch after the reset.                               *)
(* FixParts selects the #3499 guards. The shipped code is                  *)
(* {"settle","reconcile","reconcileStart"}; {} is the code before #3499.   *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS
    QuietWindow,   \* session 1's quiet window is still running at the replacement
    ResetClears,   \* resetForSession clears the cascade state (FALSE = mutant)
    Dedupe,        \* the #2890 admission gate
    ToolDrift,     \* the duplicate sees a drifted active-tool set (re-admitted)
    Strays,        \* a still-running session-1 compute records a tier-3 touch
                   \* after the reset (#3512)
    FixParts       \* the #3499 guards, a subset of
                   \*   "settle"          settleCascadeRuns drops on a stale generation
                   \*   "reconcile"       the reconcile's append drops on a stale generation
                   \*   "reconcileStart"  the reconcile stands down before its drain
                   \*   "reconcileLate"   the reconcile captures at task start, not
                   \*                     window start (mutant)

VARIABLES
    phase,      \* "s1" | "s1down" | "s2starting" | "s2"
    gen,        \* runtime._sessionGeneration
    resets,     \* resetForSession passes per session
    pending,    \* origins of parked cascade promises (_pendingCascadeRuns)
    resolved,   \* the session-1 compute has resolved
    runs,       \* origins of runs in _cascadeRuns
    touches,    \* origins of tier-3 touches in the outstanding-touch registry
    settle,     \* quiet-window settle pc: "idle" | "waiting" | "done"
    snap,       \* the pending list settle took
    settleGen,  \* generation captured for the settle
    recon,      \* quiet-window reconcile pc
    reconGen,   \* generation captured for the reconcile
    drained,    \* the touches the reconcile drained
    dropped,    \* touch origins a reconcile guard dropped
    rec2,       \* session 2 has recorded its own touch
    strayed,    \* the session-1 compute has recorded its stray touch
    dup,        \* the duplicate start has arrived
    delivered   \* [origin, at] pairs delivered by a turn_end

vars == <<phase, gen, resets, pending, resolved, runs, touches, settle, snap,
          settleGen, recon, reconGen, drained, dropped, rec2, strayed, dup,
          delivered>>

Sess == 1..2

TypeOK ==
    /\ phase \in {"s1", "s1down", "s2starting", "s2"}
    /\ gen \in 0..4
    /\ pending \subseteq Sess /\ runs \subseteq Sess /\ snap \subseteq Sess
    /\ touches \subseteq Sess /\ drained \subseteq Sess /\ dropped \subseteq Sess
    /\ resolved \in BOOLEAN /\ rec2 \in BOOLEAN /\ strayed \in BOOLEAN
    /\ settle \in {"idle", "waiting", "done"}
    /\ recon \in {"idle", "queued", "waiting", "done"}

Init ==
    /\ phase = "s1"
    /\ gen = 1
    /\ resets = [s \in Sess |-> IF s = 1 THEN 1 ELSE 0]
    /\ pending = {1}            \* a session-1 cascade compute is parked
    /\ resolved = FALSE
    /\ runs = {}
    /\ touches = {1}            \* and a session-1 tier-3 touch is outstanding
    /\ settle = "idle" /\ snap = {} /\ settleGen = 0
    /\ recon = "idle" /\ reconGen = 0 /\ drained = {}
    /\ dropped = {} /\ rec2 = FALSE /\ strayed = FALSE
    /\ dup = FALSE
    /\ delivered = {}

Resolve ==
    /\ ~resolved
    /\ resolved' = TRUE
    /\ UNCHANGED <<phase, gen, resets, pending, runs, touches, settle, snap,
                   settleGen, recon, reconGen, drained, dropped, rec2, strayed,
                   dup, delivered>>

\* agent_settled: `void runQuietWindow(...)`, which captures the generation.
Settled ==
    /\ QuietWindow /\ phase = "s1" /\ settle = "idle"
    /\ settle' = "waiting" /\ snap' = pending /\ pending' = {} /\ settleGen' = gen
    /\ recon' = "queued" /\ reconGen' = gen
    /\ UNCHANGED <<phase, gen, resets, resolved, runs, touches, drained,
                   dropped, rec2, strayed, dup, delivered>>

\* After the Promise.race: append the settled run, re-park the rest.
SettleFinish ==
    /\ settle = "waiting"
    /\ settle' = "done"
    /\ IF "settle" \in FixParts /\ settleGen # gen
         THEN UNCHANGED <<runs, pending>>
         ELSE /\ runs' = runs \cup (IF resolved THEN snap ELSE {})
              /\ pending' = pending \cup (IF resolved THEN {} ELSE snap)
    /\ UNCHANGED <<phase, gen, resets, resolved, touches, snap, settleGen,
                   recon, reconGen, drained, dropped, rec2, strayed, dup,
                   delivered>>

\* The quiet window runs its tasks in sequence: the reconcile task starts
\* only after the settle task returns. It drains the registry synchronously
\* (reconcileOutstandingCascadeTouches), with no await before the drain.
ReconStart ==
    /\ settle = "done" /\ recon = "queued"
    /\ LET g == IF "reconcileLate" \in FixParts THEN gen ELSE reconGen
       IN /\ reconGen' = g
          /\ IF "reconcileStart" \in FixParts /\ g # gen
               THEN /\ recon' = "done"
                    /\ UNCHANGED <<touches, drained>>
               ELSE /\ recon' = "waiting"
                    /\ drained' = touches
                    /\ touches' = {}
    /\ UNCHANGED <<phase, gen, resets, pending, resolved, runs, settle, snap,
                   settleGen, dropped, rec2, strayed, dup, delivered>>

\* After the per-entry awaits: onResolvedFound -> runtime.appendCascadeRun.
ReconFinish ==
    /\ recon = "waiting"
    /\ recon' = "done"
    /\ IF ({"reconcile", "reconcileLate"} \cap FixParts # {}) /\ reconGen # gen
         THEN /\ dropped' = dropped \cup drained
              /\ UNCHANGED runs
         ELSE /\ runs' = runs \cup drained
              /\ UNCHANGED dropped
    /\ drained' = {}
    /\ UNCHANGED <<phase, gen, resets, pending, resolved, touches, settle, snap,
                   settleGen, reconGen, rec2, strayed, dup, delivered>>

Shutdown1 ==
    /\ phase = "s1"
    /\ phase' = "s1down"
    /\ UNCHANGED <<gen, resets, pending, resolved, runs, touches, settle, snap,
                   settleGen, recon, reconGen, drained, dropped, rec2, strayed,
                   dup, delivered>>

\* Admission, pre-handler resets, then the awaits (configureWarmAttach,
\* ensureLSPConfigInitialized) before handleSessionStart.
StartBegin ==
    /\ phase = "s1down"
    /\ phase' = "s2starting"
    /\ UNCHANGED <<gen, resets, pending, resolved, runs, touches, settle, snap,
                   settleGen, recon, reconGen, drained, dropped, rec2, strayed,
                   dup, delivered>>

\* resetCascadeTierSessionState() and runtime.resetForSession(), in one tick
\* (runtime-session.ts:2407-2408).
ResetForSession ==
    /\ gen' = gen + 1
    /\ resets' = [resets EXCEPT ![2] = @ + 1]
    /\ runs' = IF ResetClears THEN {} ELSE runs
    /\ pending' = IF ResetClears THEN {} ELSE pending
    /\ touches' = IF ResetClears THEN {} ELSE touches

StartReset ==
    /\ phase = "s2starting"
    /\ phase' = "s2"
    /\ ResetForSession
    /\ UNCHANGED <<resolved, settle, snap, settleGen, recon, reconGen, drained,
                   dropped, rec2, strayed, dup, delivered>>

\* pi RPC's second session_start for the same (reason, session id), after
\* the first has returned (rpc-mode.js awaits rebindSession twice).
DupStart ==
    /\ phase = "s2" /\ ~dup
    /\ dup' = TRUE
    /\ IF ~Dedupe \/ ToolDrift
         THEN ResetForSession
         ELSE UNCHANGED <<gen, resets, runs, pending, touches>>
    /\ UNCHANGED <<phase, resolved, settle, snap, settleGen, recon, reconGen,
                   drained, dropped, rec2, strayed, delivered>>

\* Session 2's cascade lane records its own tier-3 touch.
Record2 ==
    /\ phase = "s2" /\ ~rec2
    /\ rec2' = TRUE
    /\ touches' = touches \cup {2}
    /\ UNCHANGED <<phase, gen, resets, pending, resolved, runs, settle, snap,
                   settleGen, recon, reconGen, drained, dropped, strayed, dup,
                   delivered>>

\* #3512: the still-running session-1 compute records its touch after the
\* reset (clients/dispatch/integration.ts recordOutstandingCascadeTouch).
Stray ==
    /\ Strays /\ phase = "s2" /\ ~resolved /\ ~strayed
    /\ strayed' = TRUE
    /\ touches' = touches \cup {1}
    /\ UNCHANGED <<phase, gen, resets, pending, resolved, runs, settle, snap,
                   settleGen, recon, reconGen, drained, dropped, rec2, dup,
                   delivered>>

\* Session 2's own quiet window reconciles, current generation. It cannot
\* start while session 1's window is still in progress (`_inProgress`).
Window2 ==
    /\ phase = "s2" /\ recon \in {"idle", "done"} /\ touches # {}
    /\ runs' = runs \cup touches
    /\ touches' = {}
    /\ UNCHANGED <<phase, gen, resets, pending, resolved, settle, snap,
                   settleGen, recon, reconGen, drained, dropped, rec2, strayed,
                   dup, delivered>>

\* Session 2's turn_end: consumeCascadeRuns() and deliver. A run's origin
\* projectSeq is session 1's, so getFilesChangedSince(originSeq) in session 2
\* (projectSeq restarted at 0) finds nothing and nothing is filtered.
TurnEnd2 ==
    /\ phase = "s2" /\ runs # {}
    /\ delivered' = delivered \cup {<<o, 2>> : o \in runs}
    /\ runs' = {}
    /\ UNCHANGED <<phase, gen, resets, pending, resolved, touches, settle, snap,
                   settleGen, recon, reconGen, drained, dropped, rec2, strayed,
                   dup>>

Next ==
    \/ Resolve \/ Settled \/ SettleFinish \/ ReconStart \/ ReconFinish
    \/ Shutdown1 \/ StartBegin \/ StartReset \/ DupStart \/ Record2 \/ Stray
    \/ Window2 \/ TurnEnd2

Spec == Init /\ [][Next]_vars

(* A run computed for session 1 is never delivered in session 2. *)
NoCrossSessionDelivery == \A d \in delivered : d[1] = d[2]

(* "Session reset still clears it" (runtime-coordinator.ts:615-616): once
   session 2's reset has run, no session-1 run or parked compute is in the
   runtime. *)
NoCrossSessionState ==
    phase = "s2" => (\A o \in runs \cup pending : o = 2)

(* Catalog shape 54, the no-drop direction: a guard never drops session 2's
   own tier-3 touch. *)
NoDropFreshTouch == 2 \notin dropped

(* One session_start mutation pass per session (#2890). *)
OneResetPerSession == \A s \in Sess : resets[s] <= 1
=============================================================================
