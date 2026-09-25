------------------------------ MODULE IdleReset ------------------------------
(***************************************************************************)
(* The detached LSP idle-reset timer against LSP work in flight.           *)
(*                                                                         *)
(* Actors:                                                                 *)
(*  - the idle timer (clients/runtime-turn.ts scheduleLSPIdleReset): on    *)
(*    fire it asks isWorkspaceSweepActive(); if a hold is live it parks a  *)
(*    re-arm on runWhenWorkspaceSweepIdle, otherwise it calls              *)
(*    resetLSPService in the same tick. resetLSPService marks the service  *)
(*    destroyed (shutdown() sets isDestroyed before its first await) and   *)
(*    nulls the singleton, so the next getLSPService() builds a new        *)
(*    generation. The clients are torn down later (Teardown);              *)
(*  - a workspace sweep (LSPService.runWorkspaceDiagnostics): takes the    *)
(*    hold for its lifetime, checks checkDestroyed() before each file and  *)
(*    marks every unreached file "service_destroyed";                      *)
(*  - hold reaping (reapStaleHolds): force-releases a hold older than      *)
(*    getWorkspaceSweepMaxHoldAgeMs; only a sweep that overran its own     *)
(*    wall-clock ceiling can be that old (SweepOverrun);                   *)
(*  - a cascade compute (computeCascadeForFile, clients/dispatch/          *)
(*    integration.ts): captures getLSPService() once, then touches each    *)
(*    neighbour concurrently. It takes no hold;                            *)
(*  - a warm-attach touch (clients/warm-attach.ts): calls getLSPService()  *)
(*    and touchFile in one tick per request. It takes no hold.             *)
(*                                                                         *)
(* A touch (LSPService.touchFile) is three steps split by awaits:          *)
(*   Entry   - checkDestroyed(); destroyed -> returns undefined;           *)
(*   Acquire - getClientForFile(); destroyed -> no client -> undefined;    *)
(*   Answer  - the diagnostics wait resolves; clients already torn down    *)
(*             -> inconclusive, otherwise a real answer.                   *)
(* What each caller makes of `undefined`:                                  *)
(*   sweep   -> timedOut, unconfirmedReason "budget"            (recorded) *)
(*   warm    -> fresh:false on the IPC answer                   (recorded) *)
(*   cascade -> `if (!rawDiags) return undefined`: the neighbour is left   *)
(*              out of the run, logged only in latency.log                 *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS
    Sweep,          \* a workspace sweep may run
    SweepOverrun,   \* the sweep may outlive the max hold age (hung touch)
    Reaping,        \* reapStaleHolds is in force
    Cascade,        \* a cascade compute (carried over, or started by a write) may run
    WarmAttach,     \* a warm-attach request from another pi session may arrive
    HoldCheck,      \* the timer consults the hold (FALSE = mutant)
    FixParts        \* candidate fix, subset of {"entry","acquire"}: a cascade
                    \* touch that sees a destroyed service at that step is kept
                    \* as an unconfirmed neighbour instead of dropped

SweepFiles == {"s1", "s2"}
Neighbours == {"n1", "n2"}
Warm       == {"w1"}
Items      == SweepFiles \cup Neighbours \cup Warm

Stages   == {"unstarted", "checked", "acquiring", "waiting", "done"}
Outcomes == {"none", "confirmed", "inconclusive", "destroyed", "budget",
             "notFresh", "dropped", "marked"}

VARIABLES
    gen,            \* current service generation
    destroyed,      \* generations whose isDestroyed is true
    dead,           \* generations whose clients were torn down
    timer,          \* "armed" | "waiting" (re-arm parked on the hold) | "fired"
    holds,          \* live hold tokens
    sweepPc, cascadePc, warmPc,   \* "idle" | "running" | "done"
    stage, outcome, svc,          \* per touch item
    resetUnderHold, resetDuringSweep

vars == <<gen, destroyed, dead, timer, holds, sweepPc, cascadePc, warmPc,
          stage, outcome, svc, resetUnderHold, resetDuringSweep>>

Init ==
    /\ gen = 0
    /\ destroyed = {}
    /\ dead = {}
    /\ timer = "armed"
    /\ holds = {}
    /\ sweepPc = "idle" /\ cascadePc = "idle" /\ warmPc = "idle"
    /\ stage = [i \in Items |-> "unstarted"]
    /\ outcome = [i \in Items |-> "none"]
    /\ svc = [i \in Items |-> 0]
    /\ resetUnderHold = FALSE
    /\ resetDuringSweep = FALSE

\* The re-arm parked by runWhenWorkspaceSweepIdle runs synchronously inside
\* the release/reap that empties the hold set (flushIdleWaitersIfEmpty).
AfterHoldsChange(newHolds) ==
    timer' = IF newHolds = {} /\ timer = "waiting" THEN "armed" ELSE timer

-----------------------------------------------------------------------------
\* The idle timer. Check and reset are one synchronous callback.
TimerFire ==
    /\ timer = "armed"
    /\ IF HoldCheck /\ holds # {}
         THEN /\ timer' = "waiting"
              /\ UNCHANGED <<gen, destroyed, resetUnderHold, resetDuringSweep>>
         ELSE /\ timer' = "fired"
              /\ destroyed' = destroyed \cup {gen}
              /\ gen' = gen + 1
              /\ resetUnderHold' = (holds # {})
              /\ resetDuringSweep' = (sweepPc = "running" /\ svc["s1"] = gen)
    /\ UNCHANGED <<dead, holds, sweepPc, cascadePc, warmPc, stage, outcome, svc>>

\* shutdown() awaits in-flight spawns, then tears the clients down.
Teardown ==
    /\ \E g \in destroyed \ dead : dead' = dead \cup {g}
    /\ UNCHANGED <<gen, destroyed, timer, holds, sweepPc, cascadePc, warmPc,
                   stage, outcome, svc, resetUnderHold, resetDuringSweep>>

\* reapStaleHolds: only an overrunning sweep's hold is ever past max age.
Reap ==
    /\ Reaping /\ SweepOverrun
    /\ "sweep" \in holds
    /\ holds' = holds \ {"sweep"}
    /\ AfterHoldsChange(holds \ {"sweep"})
    /\ UNCHANGED <<gen, destroyed, dead, sweepPc, cascadePc, warmPc,
                   stage, outcome, svc, resetUnderHold, resetDuringSweep>>

-----------------------------------------------------------------------------
\* Generic touch steps.
UndefinedResult(i) ==
    CASE i \in SweepFiles -> "budget"
      [] i \in Warm       -> "notFresh"
      [] i \in Neighbours -> "dropped"

TouchEntry(i) ==
    /\ stage[i] = "checked"
    /\ IF svc[i] \in destroyed
         THEN /\ stage' = [stage EXCEPT ![i] = "done"]
              /\ outcome' = [outcome EXCEPT ![i] =
                    IF i \in Neighbours /\ "entry" \in FixParts
                      THEN "marked" ELSE UndefinedResult(i)]
         ELSE /\ stage' = [stage EXCEPT ![i] = "acquiring"]
              /\ UNCHANGED outcome
    /\ UNCHANGED <<gen, destroyed, dead, timer, holds, sweepPc, cascadePc,
                   warmPc, svc, resetUnderHold, resetDuringSweep>>

TouchAcquire(i) ==
    /\ stage[i] = "acquiring"
    /\ IF svc[i] \in destroyed
         THEN /\ stage' = [stage EXCEPT ![i] = "done"]
              /\ outcome' = [outcome EXCEPT ![i] =
                    IF i \in Neighbours /\ "acquire" \in FixParts
                      THEN "marked" ELSE UndefinedResult(i)]
         ELSE /\ stage' = [stage EXCEPT ![i] = "waiting"]
              /\ UNCHANGED outcome
    /\ UNCHANGED <<gen, destroyed, dead, timer, holds, sweepPc, cascadePc,
                   warmPc, svc, resetUnderHold, resetDuringSweep>>

TouchAnswer(i) ==
    /\ stage[i] = "waiting"
    /\ stage' = [stage EXCEPT ![i] = "done"]
    /\ outcome' = [outcome EXCEPT ![i] =
          IF svc[i] \in dead THEN "inconclusive" ELSE "confirmed"]
    /\ UNCHANGED <<gen, destroyed, dead, timer, holds, sweepPc, cascadePc,
                   warmPc, svc, resetUnderHold, resetDuringSweep>>

-----------------------------------------------------------------------------
\* Workspace sweep: hold + capture in one tick, files in order.
SweepStart ==
    /\ Sweep /\ sweepPc = "idle"
    /\ sweepPc' = "running"
    /\ holds' = holds \cup {"sweep"}
    /\ svc' = [i \in Items |-> IF i \in SweepFiles THEN gen ELSE svc[i]]
    /\ UNCHANGED <<gen, destroyed, dead, timer, cascadePc, warmPc, stage,
                   outcome, resetUnderHold, resetDuringSweep>>

\* The per-file checkDestroyed() in the chunk loop; destroyed -> every
\* unreached file is "service_destroyed".
SweepCheck(f) ==
    /\ sweepPc = "running"
    /\ stage[f] = "unstarted"
    /\ (f = "s2" => stage["s1"] = "done")
    /\ IF svc[f] \in destroyed
         THEN /\ stage' = [i \in Items |->
                    IF i \in SweepFiles /\ stage[i] = "unstarted" THEN "done" ELSE stage[i]]
              /\ outcome' = [i \in Items |->
                    IF i \in SweepFiles /\ stage[i] = "unstarted" THEN "destroyed" ELSE outcome[i]]
         ELSE /\ stage' = [stage EXCEPT ![f] = "checked"]
              /\ UNCHANGED outcome
    /\ UNCHANGED <<gen, destroyed, dead, timer, holds, sweepPc, cascadePc,
                   warmPc, svc, resetUnderHold, resetDuringSweep>>

\* finally { releaseSweepHold() }
SweepEnd ==
    /\ sweepPc = "running"
    /\ \A f \in SweepFiles : stage[f] = "done"
    /\ sweepPc' = "done"
    /\ holds' = holds \ {"sweep"}
    /\ AfterHoldsChange(holds \ {"sweep"})
    /\ UNCHANGED <<gen, destroyed, dead, cascadePc, warmPc, stage, outcome,
                   svc, resetUnderHold, resetDuringSweep>>

\* Cascade compute: `const lspService = getLSPService()` once, then each
\* neighbour (after its own readFile await) enters touchFile.
CascadeStart ==
    /\ Cascade /\ cascadePc = "idle"
    /\ cascadePc' = "running"
    /\ svc' = [i \in Items |-> IF i \in Neighbours THEN gen ELSE svc[i]]
    /\ stage' = [i \in Items |-> IF i \in Neighbours THEN "checked" ELSE stage[i]]
    /\ UNCHANGED <<gen, destroyed, dead, timer, holds, sweepPc, warmPc,
                   outcome, resetUnderHold, resetDuringSweep>>

CascadeEnd ==
    /\ cascadePc = "running"
    /\ \A n \in Neighbours : stage[n] = "done"
    /\ cascadePc' = "done"
    /\ UNCHANGED <<gen, destroyed, dead, timer, holds, sweepPc, warmPc,
                   stage, outcome, svc, resetUnderHold, resetDuringSweep>>

\* Warm attach: `(await loadLspService()).getLSPService().touchFile(...)` -
\* the lookup and touchFile's entry check share a tick, so the entry check
\* always sees the current, undestroyed generation.
WarmStart ==
    /\ WarmAttach /\ warmPc = "idle"
    /\ warmPc' = "done"
    /\ svc' = [svc EXCEPT !["w1"] = gen]
    /\ stage' = [stage EXCEPT !["w1"] = "acquiring"]
    /\ UNCHANGED <<gen, destroyed, dead, timer, holds, sweepPc, cascadePc,
                   outcome, resetUnderHold, resetDuringSweep>>

Next ==
    \/ TimerFire \/ Teardown \/ Reap
    \/ SweepStart \/ SweepEnd \/ \E f \in SweepFiles : SweepCheck(f)
    \/ CascadeStart \/ CascadeEnd \/ WarmStart
    \/ \E i \in Items : TouchEntry(i) \/ TouchAcquire(i) \/ TouchAnswer(i)

Spec == Init /\ [][Next]_vars

-----------------------------------------------------------------------------
TypeOK ==
    /\ gen \in 0..1
    /\ timer \in {"armed", "waiting", "fired"}
    /\ stage \in [Items -> Stages]
    /\ outcome \in [Items -> Outcomes]

\* The service is never destroyed while a hold token is live.
NoResetUnderHold == ~resetUnderHold

\* The service a running sweep is touching is never destroyed under it.
NoResetDuringSweep == ~resetDuringSweep

\* A finished cascade run never presents a neighbour lost to a reset as if
\* it had not been selected: a dropped neighbour next to one that produced
\* LSP data is a clean-looking partial run with no marker. (If every
\* neighbour dropped, !producedLspData takes the passive "fallback" path,
\* which is itself marked.) Sweep "budget"/"destroyed" and warm "notFresh"
\* are recorded on the caller's result.
NoSilentLoss ==
    ~ ( /\ cascadePc = "done"
        /\ \E n \in Neighbours : outcome[n] = "dropped"
        /\ \E m \in Neighbours : outcome[m] \in {"confirmed", "inconclusive"} )

\* A sweep file lost to a reset is labelled service_destroyed, never
\* "budget" (the #1618 mislabel). No real budget timeout is modelled.
HonestSweepLabel == \A f \in SweepFiles : outcome[f] # "budget"
=============================================================================
