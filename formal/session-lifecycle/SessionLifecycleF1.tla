------------------------ MODULE SessionLifecycleF1 ------------------------
(***************************************************************************)
(* #3803 lane F1: the stores SessionLifecycle leaves out, composed with    *)
(* its host transitions. The module EXTENDS SessionLifecycle and adds its  *)
(* own variables, so every transition, policy table and invariant of the   *)
(* base model is the one the other configs check; a base transition moves  *)
(* the stores below through `Hook` and nothing else.                       *)
(*                                                                         *)
(*  1. The widget's write token (clients/write-ordering-guard.ts, used by  *)
(*     clients/widget-state.ts) and the widget's rows. A pipeline's        *)
(*     verdict is two verbs, `recordDiagnostics` and `recordRunner`, each  *)
(*     behind its own WriteOrderingGuard; either may complete first, and   *)
(*     whichever does advances BOTH guards to the pipeline's token         *)
(*     (`admitWidgetDiagnosticsWrite`, `recordRunner`). The second verb    *)
(*     therefore arrives at a token equal to its guard's in this bounded     *)
(*     model; the real pipeline can re-token mid-flight. The guard's `>=`  *)
(*     (a tie proceeds) is still the tested behavior. A widget start's       *)
(*     policy (`widgetStore`) resets the rows and both guards together:    *)
(*     the fork start did before #3589.                                    *)
(*  2. The coordinator and module stores that late tool_result writers     *)
(*     reach after an await: the mutation receipts                         *)
(*     (`recordMutationToolReceipt`), `fixedThisTurn`, the analysed-state  *)
(*     latch (`lastAnalyzedStateByFile`, a module map the turn start       *)
(*     clears, not the session reset), the complexity baselines            *)
(*     (`complexityBaselines`, written by the tool_call hook after its     *)
(*     awaits) and the pending runner findings                             *)
(*     (`deferRunnerFindings`; its readers are formal/pending-runner-store *)
(*     and are not repeated here). Each writer captures its scope at hook  *)
(*     entry and `guardedWrite`s through it (#3824); without the part it   *)
(*     writes the live store whenever it lands.                            *)
(*                                                                         *)
(* Parts of FixParts this module reads:                                    *)
(*   "widgetFence"    a proposed shape: a widget write drops once its      *)
(*                    scope retires; no such fence is on master           *)
(*   "widgetStrict"   mutant: the guard drops a tie (`>` for `>=`)         *)
(*   "widgetNoGuard"  mutant: no ordering guard (pre-#555 widget-state)    *)
(*   "fenceReceipt", "fenceFixed", "fenceLatch", "fenceRunner"             *)
(*                    the store's write drops once its scope retired       *)
(*   "fenceBaseline"  the same for `complexityBaselines`, whose tool_call  *)
(*                    writer has no fence on master (a proposed shape)     *)
(*   "storeBranchFence"  mutant: the same writes are fenced at branch      *)
(*                    level, so a /tree drops a live scope's own write     *)
(* Transitions it reads: "WidgetPipe", "StoreReceipt", "StoreFixed",       *)
(* "StoreLatch", "StoreRunner", "StoreBaseline".                           *)
(***************************************************************************)
EXTENDS SessionLifecycle

WidgetKinds == {"diag", "runner"}
StoreKinds  == {"receipt", "fixed", "latch", "runner", "baseline"}
NoRow       == [o |-> 0, tk |-> 0]
IdleRun     == [pc |-> "idle", o |-> 0, tk |-> 0, left |-> {}]
IdleStore   == [pc |-> "idle", s |-> 0, ep |-> 0]

VARIABLES
    ww,    \* two widget pipeline runs [pc, o: its scope, tk: its token, left: verbs]
    wv,    \* the widget's rows, one per verb: [o, tk]
    gt,    \* the two guards' last-seen tokens
    wm,    \* ghost: the highest token a verb accepted since the rows last reset
    wl,    \* ghost: the verb has landed since the last reset the design allows
    fdrop, \* ghost: a guard dropped a verb of the newest pipeline run
    sw,    \* store writers, one slot per kind
    sc,    \* store contents: the scopes whose writes landed
    sdrop  \* ghost: a fence dropped a write of a live scope

ext == <<ww, wv, gt, wm, wl, fdrop, sw, sc, sdrop>>
\* WBegin packs two run identities into the write token; MaxSteps = 2 keeps
\* that abstraction collision-free. Production uses a wider turn/index pack.
varsF1 == <<vars, ext>>

InitF1 ==
    /\ Init
    /\ ww = [i \in 1..2 |-> IdleRun]
    /\ wv = [k \in WidgetKinds |-> NoRow]
    /\ gt = [k \in WidgetKinds |-> 0]
    /\ wm = [k \in WidgetKinds |-> 0]
    /\ wl = [k \in WidgetKinds |-> FALSE]
    /\ fdrop = FALSE
    /\ sw = [k \in StoreKinds |-> IdleStore]
    /\ sc = [k \in StoreKinds |-> {}]
    /\ sdrop = FALSE

-----------------------------------------------------------------------------
(* Base transitions move the stores.                                       *)

\* A new primary scope started (Begin or PiFork): the coordinator's reset.
Started == pend.k # "none" /\ pend'.k = "none" /\ primary = 0 /\ primary' # 0
StartReason == IF pend.k = "quit" THEN "piFork" ELSE pend.k
\* The policy table in force resets the widget; the design's table (the truth
\* the invariant reads, whatever the config's policy) does so for a start that
\* begins another conversation or adopts a sidecar, never for /reload, /fork,
\* /clone or /tree.
WReset == Started /\ Policy("WG", StartReason) = "reset"
WTruthReset == Started /\ TargetPolicy("WG", StartReason) = "reset"
\* A turn_start of any session clears the module-level analysed-state latch
\* (`clearLastAnalyzedStateCache`, #3613).
TurnBegan == turns' > turns

Hook ==
    /\ wv' = IF WReset THEN [k \in WidgetKinds |-> NoRow] ELSE wv
    /\ gt' = IF WReset THEN [k \in WidgetKinds |-> 0] ELSE gt
    /\ wm' = IF WReset THEN [k \in WidgetKinds |-> 0] ELSE wm
    /\ wl' = IF WTruthReset THEN [k \in WidgetKinds |-> FALSE] ELSE wl
    /\ sc' = [k \in StoreKinds |->
                IF k = "latch" THEN (IF TurnBegan THEN {} ELSE sc[k])
                ELSE IF Started THEN {} ELSE sc[k]]
    /\ UNCHANGED <<ww, fdrop, sw, sdrop>>

\* `pi --fork` crosses a real process boundary. The production process exits,
\* so in-flight widget pipelines cannot land in the child, and the child's
\* module-local guards and rows start empty. Keep the F1 extension aligned
\* with `PiFork`'s reset of the base process-local order state.
PiForkF1 ==
    /\ PiFork
    /\ ww' = [i \in 1..2 |-> IdleRun]
    /\ wv' = [k \in WidgetKinds |-> NoRow]
    /\ gt' = [k \in WidgetKinds |-> 0]
    /\ wm' = [k \in WidgetKinds |-> 0]
    /\ wl' = [k \in WidgetKinds |-> FALSE]
    /\ fdrop' = FALSE
    /\ sw' = [k \in StoreKinds |-> IdleStore]
    /\ sc' = [k \in StoreKinds |-> {}]
    /\ sdrop' = FALSE
    /\ UNCHANGED m4V

-----------------------------------------------------------------------------
(* The widget's pipeline writers.                                          *)

\* WriteOrderingGuard.shouldWrite: a token below the last seen is dropped; a
\* tie proceeds ("widgetStrict" drops it); no guard lets everything through.
Pass(tk, seen) ==
    IF Has("widgetNoGuard") THEN TRUE
    ELSE IF Has("widgetStrict") THEN tk > seen
    ELSE tk >= seen

\* A pipeline run in a turn the primary began. Its token is the order turn
\* and the run's write index (`writeOrderToken`: the turn leads), so a later
\* run outranks an earlier one of the same turn. Run 2 begins after run 1, in
\* the same process or, after pi --fork restarted the order turn, a later one.
WBegin(i) ==
    /\ "WidgetPipe" \in Transitions
    /\ ww[i].pc = "idle" /\ (i = 1 \/ ww[1].pc # "idle")
    /\ primary # 0 /\ pend.k = "none" /\ begun[primary] > 0
    /\ ww' = [ww EXCEPT ![i] = [pc |-> "flight", o |-> primary,
                                 tk |-> OrderNow * 4 + i, left |-> WidgetKinds]]
    /\ UNCHANGED <<vars, wv, gt, wm, wl, fdrop, sw, sc, sdrop>>

\* One verb lands, at any later step. It checks its own guard, then advances
\* both guards when it passes (the other guard's shouldWrite).
WLand(i, k) ==
    /\ ww[i].pc = "flight" /\ k \in ww[i].left
    /\ LET w == ww[i]
           k2 == CHOOSE x \in WidgetKinds : x # k
           fenced == Has("widgetFence") /\ st[w.o] # "live"
           pass == Pass(w.tk, gt[k])
           left2 == w.left \ {k}
           newest == \A j \in 1..2 : ww[j].pc = "idle" \/ ww[j].tk <= w.tk
       IN
       /\ ww' = [ww EXCEPT ![i] = [w EXCEPT !.left = left2,
                                    !.pc = IF left2 = {} THEN "done" ELSE "flight"]]
       /\ IF fenced
          THEN UNCHANGED <<wv, gt, wm, wl, fdrop>>
          ELSE IF pass
               THEN /\ wm' = [wm EXCEPT ![k] = IF w.tk > @ THEN w.tk ELSE @]
                    /\ wv' = [wv EXCEPT ![k] = [o |-> w.o, tk |-> w.tk]]
                    /\ wl' = [wl EXCEPT ![k] = TRUE]
                    /\ gt' = [gt EXCEPT ![k] = w.tk,
                                        ![k2] = IF Pass(w.tk, gt[k2]) THEN w.tk
                                                ELSE gt[k2]]
                    /\ UNCHANGED fdrop
               ELSE /\ fdrop' = (fdrop \/ newest)
                    /\ UNCHANGED <<wv, wm, wl, gt>>
    /\ UNCHANGED <<vars, sw, sc, sdrop>>

-----------------------------------------------------------------------------
(* The coordinator's and the modules' late-written stores.                  *)

StoreFence(k) ==
    CASE k = "receipt" -> "fenceReceipt" [] k = "fixed" -> "fenceFixed"
      [] k = "latch" -> "fenceLatch" [] k = "runner" -> "fenceRunner"
      [] k = "baseline" -> "fenceBaseline"

TransName(k) ==
    CASE k = "receipt" -> "StoreReceipt" [] k = "fixed" -> "StoreFixed"
      [] k = "latch" -> "StoreLatch" [] k = "runner" -> "StoreRunner"
      [] k = "baseline" -> "StoreBaseline"

\* A tool_result of a live scope, primary or a concurrent subagent (which
\* shares the coordinator), captured its handle at hook entry and writes after
\* an await.
SBegin(k) ==
    /\ TransName(k) \in Transitions /\ sw[k].pc = "idle"
    /\ \E s \in Tickets :
          /\ st[s] = "live"
          /\ sw' = [sw EXCEPT ![k] = [pc |-> "flight", s |-> s, ep |-> ep[s]]]
    /\ UNCHANGED <<vars, ww, wv, gt, wm, wl, fdrop, sc, sdrop>>

SLand(k) ==
    /\ sw[k].pc = "flight"
    /\ LET w == sw[k]
           bySession == Has(StoreFence(k)) /\ st[w.s] # "live"
           byBranch == Has("storeBranchFence") /\ ep[w.s] # w.ep
           dropped == bySession \/ byBranch
       IN
       /\ sw' = [sw EXCEPT ![k].pc = IF dropped THEN "dropped" ELSE "landed"]
       /\ sc' = IF dropped THEN sc ELSE [sc EXCEPT ![k] = @ \cup {w.s}]
       /\ sdrop' = (sdrop \/ (dropped /\ st[w.s] = "live"))
    /\ UNCHANGED <<vars, ww, wv, gt, wm, wl, fdrop>>

NextF1 ==
    \/ Next /\ Hook
    \/ PiForkF1
    \/ \E i \in 1..2 : WBegin(i)
    \/ \E i \in 1..2, k \in WidgetKinds : WLand(i, k)
    \/ \E k \in StoreKinds : SBegin(k)
    \/ \E k \in StoreKinds : SLand(k)

SpecF1 == InitF1 /\ [][NextF1]_varsF1

-----------------------------------------------------------------------------
(* Invariants.                                                             *)

TypeOKF1 ==
    /\ TypeOK
    /\ \A i \in 1..2 : ww[i].pc \in {"idle", "flight", "done"}
    /\ fdrop \in BOOLEAN
    /\ \A k \in WidgetKinds : wv[k].tk \in Nat /\ gt[k] \in Nat /\ wm[k] \in Nat
    /\ \A k \in StoreKinds : sc[k] \subseteq Tickets
                              /\ sw[k].pc \in {"idle", "flight", "landed", "dropped"}

\* The widget's rows belong to the live conversation: a row's writer is of the
\* primary's lineage (a retired session's late verb after /new is not).
WidgetInLineage ==
    primary # 0 => \A k \in WidgetKinds :
        wv[k].tk = 0 \/ wv[k].o \in lin[sess[primary]]

\* Catalog shape 54, the safety direction: a verb's row is the newest token the
\* guard accepted since the rows last reset, so an older pipeline's verb that
\* lands after a newer one's never overwrites it (no guard).
ShowsNewest == \A k \in WidgetKinds : wv[k].tk = wm[k]

\* The no-drop direction: no guard drops a verb of the newest pipeline run (the
\* last to begin).
\* A pipeline's second verb arrives at the token its first verb advanced both
\* guards to, so a guard that drops a tie loses it (a strict guard).
NoOwnDropWidget == ~fdrop

\* #3589: a verb that landed since the last reset the design allows is still
\* in the widget. /reload, /fork, /clone and /tree carry it; a start that
\* resets the policy's table without the design's loses a fork's.
NoLostWidget == \A k \in WidgetKinds : wl[k] => wv[k].tk > 0

\* #3824: once a primary is registered, the receipt, fixed-this-turn and
\* runner stores hold only live scopes' writes (a concurrent subagent's
\* included); the analysed-state latch holds only live scopes' once the
\* primary's first turn started and cleared it.
StoreOwnersLive ==
    /\ \A k \in {"receipt", "fixed", "runner", "baseline"} :
          primary # 0 => \A s \in sc[k] : st[s] = "live" \/ role[s] = "secondary"
    /\ (primary # 0 /\ begun[primary] > 0)
          => \A s \in sc["latch"] : st[s] = "live" \/ role[s] = "secondary"

\* Shape 54, the no-drop direction: no fence drops a write of a live scope.
NoOwnDropStores == ~sdrop

=============================================================================
