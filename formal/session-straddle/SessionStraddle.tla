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
(*    own await (index.ts:3380-3389). FixParts selects which of those      *)
(*    writes drop on a stale generation: {"settle","reconcile"} is the     *)
(*    shipped code, {} the code before #3499.                              *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS
    QuietWindow,   \* session 1's quiet window is still running at the replacement
    ResetClears,   \* resetForSession clears the cascade state (FALSE = mutant)
    Dedupe,        \* the #2890 admission gate
    ToolDrift,     \* the duplicate sees a drifted active-tool set (re-admitted)
    FixParts       \* the #3499 guards, subset of {"settle","reconcile"}
                   \* ("reconcileLate": the reconcile guard captures late)

VARIABLES
    phase,      \* "s1" | "s1down" | "s2starting" | "s2"
    gen,        \* runtime._sessionGeneration
    resets,     \* resetForSession passes per session
    pending,    \* origins of parked cascade promises (_pendingCascadeRuns)
    resolved,   \* the session-1 compute has resolved
    runs,       \* origins of runs in _cascadeRuns
    settle,     \* quiet-window settle pc: "idle" | "waiting" | "done"
    snap,       \* the pending list settle took
    settleGen,  \* generation captured at settle start (fix)
    recon,      \* quiet-window reconcile pc
    reconGen,
    dup,        \* the duplicate start has arrived
    delivered   \* [origin, at] pairs delivered by a turn_end

vars == <<phase, gen, resets, pending, resolved, runs, settle, snap,
          settleGen, recon, reconGen, dup, delivered>>

Sess == 1..2
Cur == IF phase = "s2" THEN 2 ELSE 1   \* session whose reset is in force

TypeOK ==
    /\ phase \in {"s1", "s1down", "s2starting", "s2"}
    /\ gen \in 0..4
    /\ pending \subseteq Sess /\ runs \subseteq Sess /\ snap \subseteq Sess
    /\ resolved \in BOOLEAN
    /\ settle \in {"idle", "waiting", "done"}
    /\ recon \in {"idle", "queued", "waiting", "done"}

Init ==
    /\ phase = "s1"
    /\ gen = 1
    /\ resets = [s \in Sess |-> IF s = 1 THEN 1 ELSE 0]
    /\ pending = {1}            \* a session-1 cascade compute is parked
    /\ resolved = FALSE
    /\ runs = {}
    /\ settle = "idle" /\ snap = {} /\ settleGen = 0
    /\ recon = "idle" /\ reconGen = 0
    /\ dup = FALSE
    /\ delivered = {}

Resolve ==
    /\ ~resolved
    /\ resolved' = TRUE
    /\ UNCHANGED <<phase, gen, resets, pending, runs, settle, snap, settleGen,
                   recon, reconGen, dup, delivered>>

\* agent_settled: `void runQuietWindow(...)`.
Settled ==
    /\ QuietWindow /\ phase = "s1" /\ settle = "idle"
    /\ settle' = "waiting" /\ snap' = pending /\ pending' = {} /\ settleGen' = gen
    /\ recon' = "queued" /\ reconGen' = gen
    /\ UNCHANGED <<phase, gen, resets, resolved, runs, dup, delivered>>

\* After the Promise.race: append the settled run, re-park the rest.
SettleFinish ==
    /\ settle = "waiting"
    /\ settle' = "done"
    /\ IF "settle" \in FixParts /\ settleGen # gen
         THEN UNCHANGED <<runs, pending>>
         ELSE /\ runs' = runs \cup (IF resolved THEN snap ELSE {})
              /\ pending' = pending \cup (IF resolved THEN {} ELSE snap)
    /\ UNCHANGED <<phase, gen, resets, resolved, snap, settleGen, recon,
                   reconGen, dup, delivered>>

\* The quiet window runs its tasks in sequence: the reconcile task starts
\* only after the settle task returns. Fix mutant "reconcileLate" captures
\* the generation when the task starts instead of when the window starts.
ReconStart ==
    /\ settle = "done" /\ recon = "queued"
    /\ recon' = "waiting"
    /\ reconGen' = IF "reconcileLate" \in FixParts THEN gen ELSE reconGen
    /\ UNCHANGED <<phase, gen, resets, pending, resolved, runs, settle, snap,
                   settleGen, dup, delivered>>

\* onResolvedFound -> runtime.appendCascadeRun(run).
ReconFinish ==
    /\ recon = "waiting"
    /\ recon' = "done"
    /\ runs' = IF ({"reconcile", "reconcileLate"} \cap FixParts # {}) /\ reconGen # gen THEN runs
               ELSE runs \cup {1}
    /\ UNCHANGED <<phase, gen, resets, pending, resolved, settle, snap,
                   settleGen, reconGen, dup, delivered>>

Shutdown1 ==
    /\ phase = "s1"
    /\ phase' = "s1down"
    /\ UNCHANGED <<gen, resets, pending, resolved, runs, settle, snap,
                   settleGen, recon, reconGen, dup, delivered>>

\* Admission, pre-handler resets, then the awaits (configureWarmAttach,
\* ensureLSPConfigInitialized) before handleSessionStart.
StartBegin ==
    /\ phase = "s1down"
    /\ phase' = "s2starting"
    /\ UNCHANGED <<gen, resets, pending, resolved, runs, settle, snap,
                   settleGen, recon, reconGen, dup, delivered>>

ResetForSession ==
    /\ gen' = gen + 1
    /\ resets' = [resets EXCEPT ![2] = @ + 1]
    /\ runs' = IF ResetClears THEN {} ELSE runs
    /\ pending' = IF ResetClears THEN {} ELSE pending

StartReset ==
    /\ phase = "s2starting"
    /\ phase' = "s2"
    /\ ResetForSession
    /\ UNCHANGED <<resolved, settle, snap, settleGen, recon, reconGen, dup, delivered>>

\* pi RPC's second session_start for the same (reason, session id), after
\* the first has returned (rpc-mode.js awaits rebindSession twice).
DupStart ==
    /\ phase = "s2" /\ ~dup
    /\ dup' = TRUE
    /\ IF ~Dedupe \/ ToolDrift
         THEN ResetForSession
         ELSE UNCHANGED <<gen, resets, runs, pending>>
    /\ UNCHANGED <<phase, resolved, settle, snap, settleGen, recon, reconGen, delivered>>

\* Session 2's turn_end: consumeCascadeRuns() and deliver. A run's origin
\* projectSeq is session 1's, so getFilesChangedSince(originSeq) in session 2
\* (projectSeq restarted at 0) finds nothing and nothing is filtered.
TurnEnd2 ==
    /\ phase = "s2" /\ runs # {}
    /\ delivered' = delivered \cup {<<o, 2>> : o \in runs}
    /\ runs' = {}
    /\ UNCHANGED <<phase, gen, resets, pending, resolved, settle, snap,
                   settleGen, recon, reconGen, dup>>

Next ==
    \/ Resolve \/ Settled \/ SettleFinish \/ ReconStart \/ ReconFinish
    \/ Shutdown1 \/ StartBegin \/ StartReset \/ DupStart \/ TurnEnd2

Spec == Init /\ [][Next]_vars

(* A run computed for session 1 is never delivered in session 2. *)
NoCrossSessionDelivery == \A d \in delivered : d[1] = d[2]

(* "Session reset still clears it" (runtime-coordinator.ts:611): once
   session 2's reset has run, no session-1 run or parked compute is in the
   runtime. *)
NoCrossSessionState ==
    phase = "s2" => (\A o \in runs \cup pending : o = 2)

(* One session_start mutation pass per session (#2890). *)
OneResetPerSession == \A s \in Sess : resets[s] <= 1
=============================================================================
