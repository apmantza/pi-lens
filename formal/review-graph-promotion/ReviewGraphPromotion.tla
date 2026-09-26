------------------------- MODULE ReviewGraphPromotion -------------------------
(***************************************************************************)
(* Worker-thread persist and promotion of the review-graph snapshot        *)
(* (clients/review-graph/builder.ts ~1961-2920, persist-worker.ts) for ONE  *)
(* project cache dir, shared by N pi-lens processes (a pi session and the  *)
(* MCP server, or two pi sessions in one checkout).                        *)
(*                                                                         *)
(* Adapted from the project-snapshot promotion model of #3509. What        *)
(* differs for the review graph:                                           *)
(*  - there is no meta sidecar: the signatures travel INSIDE the body      *)
(*    (PersistedGraphData.signature / fileSignatures, ~1752-1767), so the  *)
(*    body/meta pair of #3509 does not exist;                              *)
(*  - every persistGraph call takes a fresh generation (~2830-2836);       *)
(*    there is no one-active queue. Several requests can be in the worker  *)
(*    at once and only the current generation promotes (~2376-2377);      *)
(*  - a debounced `pending` slot coalesces admissions (~2002, ~2912-2922); *)
(*  - the sweep checks pid liveness (isStaleReviewGraphStageFile ~2728);   *)
(*  - builds that differ in changedFiles are NOT deduped (buildCacheKey    *)
(*    ~5967), so two builds of one workspace can run at once in one        *)
(*    process, and persistGraph runs at build END (~5138, ~5357, ~5889).   *)
(*                                                                         *)
(* Actors, per process p:                                                  *)
(*  - Advance(p): p's tree view moves to a newer seq (stat time).          *)
(*  - BuildStart(p): a build captures the current view (its signatures    *)
(*    are statted at the start: sourceSignatureMapAsync ~5559).            *)
(*  - BuildEnd(p, b): persistGraph: generation+1, replace `pending`.       *)
(*  - Dispatch(p): the debounce timer fires: writePending (~2619-2657)     *)
(*    posts to the worker, or writes synchronously if the worker is gone.  *)
(*  - Stage(p, r): the worker writes `<gz>.stage-<pid>-<gen>`.             *)
(*  - Promote(p, r): handleWorkerResult (~2360-2459): generation gate,     *)
(*    then renameSync(stage, gz); a missing stage falls back to the        *)
(*    synchronous writer with the same payload.                            *)
(*  - WorkerDeath(p): handleWorkerDeath (~2511-2552): the current-gen      *)
(*    request is written synchronously, the rest are dropped; later        *)
(*    dispatches write synchronously.                                      *)
(*  - Flush(p): flushReviewGraphPersist (CLI / exit hook, ~3485-3550):     *)
(*    newest of pending+in-flight, every in-flight request forgotten       *)
(*    (late results are only rm'd); since #3536 a candidate older than the *)
(*    current generation is dropped unwritten, else the generation is      *)
(*    bumped past it and it is written synchronously.                      *)
(*  - Sweep(p): sweepStaleStageFiles, once per cache dir (~2737-2748).     *)
(*  - Crash(p): the process dies; stage files stay on disk.                *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS
    Procs,          \* process ids (model values)
    MaxSeq,         \* largest view seq
    MaxBuilds,      \* builds per process
    Conc,           \* max concurrent builds per process (1 = serialized)
    GenGate,        \* today TRUE: the generation gate at promotion
    SweepLiveness,  \* today TRUE: the sweep skips stage files of live pids
    AllowCrash,     \* a process may die
    AllowWorkerDeath,
    FlushCurrentOnly \* since #3536 TRUE: the flush writes only the CURRENT generation

NoReq == [none |-> TRUE]

VARIABLES
    view,       \* view[p]
    alive,
    nbuilds,    \* builds started so far
    builds,     \* in-flight builds: set of [id, seq]
    gen,        \* _persistGenerations for the key
    pending,    \* _pendingPersist: NoReq or [g, seq]
    inflight,   \* _workerRequests: set of [g, seq, phase]
    workerOK,   \* the persist worker is usable
    swept,
    stages,     \* stage files: set of [p, g, seq]
    body,       \* canonical review-graph.json.gz: [p, g, seq]
    hi,         \* history: highest seq ever promoted
    promGen,    \* history: highest generation p promoted
    promSeq,    \* history: highest view seq p promoted
    genBad,     \* p put an older generation of its own over a newer one
    viewBad,    \* p put an older view of its own over a newer one
    lostStage,  \* a live process found its own stage removed by a sibling
    staleProm   \* p promoted a generation that is not its current one

vars == <<view, alive, nbuilds, builds, gen, pending, inflight, workerOK,
          swept, stages, body, hi, promGen, promSeq, genBad, viewBad,
          lostStage, staleProm>>
hist == <<hi, promGen, promSeq, genBad, viewBad, lostStage, staleProm>>

Init ==
    /\ view = [p \in Procs |-> 1]
    /\ alive = [p \in Procs |-> TRUE]
    /\ nbuilds = [p \in Procs |-> 0]
    /\ builds = [p \in Procs |-> {}]
    /\ gen = [p \in Procs |-> 0]
    /\ pending = [p \in Procs |-> NoReq]
    /\ inflight = [p \in Procs |-> {}]
    /\ workerOK = [p \in Procs |-> TRUE]
    /\ swept = [p \in Procs |-> FALSE]
    /\ stages = {}
    /\ body = [p |-> "init", g |-> 0, seq |-> 0]
    /\ hi = 0
    /\ promGen = [p \in Procs |-> 0]
    /\ promSeq = [p \in Procs |-> 0]
    /\ genBad = FALSE
    /\ viewBad = FALSE
    /\ lostStage = FALSE
    /\ staleProm = FALSE

Max(a, b) == IF a >= b THEN a ELSE b
HasStage(p, g) == \E s \in stages : s.p = p /\ s.g = g
DropStage(p, g) == {s \in stages : ~(s.p = p /\ s.g = g)}

\* Put p's generation g (view seq) into the canonical slot.
WriteBody(p, g, seq) ==
    /\ body' = [p |-> p, g |-> g, seq |-> seq]
    /\ hi' = Max(hi, seq)
    /\ genBad' = (genBad \/ g < promGen[p])
    /\ viewBad' = (viewBad \/ seq < promSeq[p])
    /\ promGen' = [promGen EXCEPT ![p] = Max(@, g)]
    /\ promSeq' = [promSeq EXCEPT ![p] = Max(@, seq)]

Advance(p) ==
    /\ alive[p] /\ view[p] < MaxSeq
    /\ view' = [view EXCEPT ![p] = @ + 1]
    /\ UNCHANGED <<alive, nbuilds, builds, gen, pending, inflight, workerOK,
                   swept, stages, body>> /\ UNCHANGED hist

BuildStart(p) ==
    /\ alive[p] /\ nbuilds[p] < MaxBuilds /\ Cardinality(builds[p]) < Conc
    /\ nbuilds' = [nbuilds EXCEPT ![p] = @ + 1]
    /\ builds' = [builds EXCEPT ![p] = @ \union {[id |-> nbuilds[p] + 1, seq |-> view[p]]}]
    /\ UNCHANGED <<view, alive, gen, pending, inflight, workerOK, swept,
                   stages, body>> /\ UNCHANGED hist

\* persistGraph (~2754-2923): fresh generation, replaces the pending slot.
BuildEnd(p, b) ==
    /\ alive[p] /\ b \in builds[p]
    /\ builds' = [builds EXCEPT ![p] = @ \ {b}]
    /\ gen' = [gen EXCEPT ![p] = @ + 1]
    /\ pending' = [pending EXCEPT ![p] = [g |-> gen[p] + 1, seq |-> b.seq]]
    /\ UNCHANGED <<view, alive, nbuilds, inflight, workerOK, swept, stages,
                   body>> /\ UNCHANGED hist

\* writePending (~2619-2657).
Dispatch(p) ==
    /\ alive[p] /\ pending[p] /= NoReq
    /\ pending' = [pending EXCEPT ![p] = NoReq]
    /\ IF workerOK[p]
       THEN /\ inflight' = [inflight EXCEPT ![p] = @ \union
                   {[g |-> pending[p].g, seq |-> pending[p].seq, phase |-> "posted"]}]
            /\ UNCHANGED <<body>> /\ UNCHANGED hist
       ELSE /\ WriteBody(p, pending[p].g, pending[p].seq)
            /\ UNCHANGED <<lostStage, staleProm, inflight>>
    /\ UNCHANGED <<view, alive, nbuilds, builds, gen, workerOK, swept, stages>>

Stage(p, r) ==
    /\ alive[p] /\ r \in inflight[p] /\ r.phase = "posted"
    /\ stages' = DropStage(p, r.g) \union {[p |-> p, g |-> r.g, seq |-> r.seq]}
    /\ inflight' = [inflight EXCEPT ![p] = (@ \ {r}) \union {[r EXCEPT !.phase = "staged"]}]
    /\ UNCHANGED <<view, alive, nbuilds, builds, gen, pending, workerOK,
                   swept, body>> /\ UNCHANGED hist

\* handleWorkerResult (~2360-2459). Synchronous: one step.
Promote(p, r) ==
    /\ alive[p] /\ r \in inflight[p] /\ r.phase = "staged"
    /\ inflight' = [inflight EXCEPT ![p] = @ \ {r}]
    /\ stages' = DropStage(p, r.g)
    /\ IF GenGate /\ gen[p] /= r.g
       THEN UNCHANGED <<body>> /\ UNCHANGED hist
       ELSE /\ WriteBody(p, r.g, r.seq)
            /\ lostStage' = (lostStage \/ ~HasStage(p, r.g))
            /\ staleProm' = (staleProm \/ gen[p] /= r.g)
    /\ UNCHANGED <<view, alive, nbuilds, builds, gen, pending, workerOK, swept>>

\* handleWorkerDeath (~2511-2552): the current generation is written on the
\* main thread; superseded requests are dropped; their stage files stay.
WorkerDeath(p) ==
    /\ AllowWorkerDeath /\ alive[p] /\ workerOK[p]
    /\ workerOK' = [workerOK EXCEPT ![p] = FALSE]
    /\ inflight' = [inflight EXCEPT ![p] = {}]
    /\ IF \E r \in inflight[p] : r.g = gen[p]
       THEN LET r == CHOOSE x \in inflight[p] : x.g = gen[p] IN
            /\ WriteBody(p, r.g, r.seq)
            /\ UNCHANGED <<lostStage, staleProm>>
       ELSE UNCHANGED <<body>> /\ UNCHANGED hist
    /\ UNCHANGED <<view, alive, nbuilds, builds, gen, pending, swept, stages>>

\* flushReviewGraphPersist (~3485-3530): newest of pending + in-flight;
\* generation bumped past it; in-flight requests forgotten; sync write.
Flush(p) ==
    /\ alive[p]
    /\ LET cands == inflight[p] \union
                    (IF pending[p] = NoReq THEN {}
                     ELSE {[g |-> pending[p].g, seq |-> pending[p].seq, phase |-> "pending"]})
           \* #3536: only the current generation. Before it (FlushCurrentOnly
           \* = FALSE): the newest candidate, even one already superseded by
           \* a generation that has promoted.
           elig == IF FlushCurrentOnly THEN {x \in cands : x.g = gen[p]} ELSE cands
           top == CHOOSE x \in elig : \A y \in elig : y.g <= x.g
       IN /\ cands /= {}
          \* a dropped flush returns before the generation bump
          /\ gen' = IF elig = {} THEN gen ELSE [gen EXCEPT ![p] = Max(@, top.g) + 1]
          /\ pending' = [pending EXCEPT ![p] = NoReq]
          /\ inflight' = [inflight EXCEPT ![p] = {}]
          \* late results of forgotten requests hit the no-request branch
          \* and are rm'd: drop their stage files now.
          /\ stages' = {s \in stages : ~(s.p = p /\ \E x \in inflight[p] : x.g = s.g)}
          /\ IF elig = {}
             THEN UNCHANGED <<body>> /\ UNCHANGED hist
             ELSE /\ WriteBody(p, top.g, top.seq)
                  /\ lostStage' = lostStage
                  /\ staleProm' = (staleProm \/ top.g /= gen[p])
    /\ UNCHANGED <<view, alive, nbuilds, builds, workerOK, swept>>

\* sweepStaleStageFiles (~2737-2748): once, from the first persistGraph.
Sweep(p) ==
    /\ alive[p] /\ ~swept[p] /\ gen[p] > 0
    /\ swept' = [swept EXCEPT ![p] = TRUE]
    /\ stages' = {s \in stages : s.p = p \/ (SweepLiveness /\ alive[s.p])}
    /\ UNCHANGED <<view, alive, nbuilds, builds, gen, pending, inflight,
                   workerOK, body>> /\ UNCHANGED hist

Crash(p) ==
    /\ AllowCrash /\ alive[p]
    /\ alive' = [alive EXCEPT ![p] = FALSE]
    /\ builds' = [builds EXCEPT ![p] = {}]
    /\ pending' = [pending EXCEPT ![p] = NoReq]
    /\ inflight' = [inflight EXCEPT ![p] = {}]
    /\ UNCHANGED <<view, nbuilds, gen, workerOK, swept, stages, body>>
    /\ UNCHANGED hist

Next ==
    \E p \in Procs :
        \/ Advance(p) \/ BuildStart(p) \/ Dispatch(p) \/ WorkerDeath(p)
        \/ Flush(p) \/ Sweep(p) \/ Crash(p)
        \/ \E b \in builds[p] : BuildEnd(p, b)
        \/ \E r \in inflight[p] : Stage(p, r) \/ Promote(p, r)

\* Fairness for everything a live process does on its own; Crash, Advance,
\* BuildStart and Flush are environment choices and are not fair.
Fairness ==
    \A p \in Procs :
        /\ WF_vars(\E b \in builds[p] : BuildEnd(p, b))
        /\ WF_vars(Dispatch(p))
        /\ WF_vars(\E r \in inflight[p] : Stage(p, r))
        /\ WF_vars(\E r \in inflight[p] : Promote(p, r))

Spec == Init /\ [][Next]_vars
FairSpec == Spec /\ Fairness

(***************************************************************************)
(* Invariants                                                              *)
(***************************************************************************)
\* The generation gate's promise (#1318/#1322): only the current generation
\* is ever promoted.
NoSupersededPromotion == ~staleProm

\* A process never puts one of its own older persists over a newer one.
InProcessLatestPersistWins == ~genBad

\* A process never puts an older VIEW of its own over a newer one it already
\* promoted (a build that started earlier but finished later).
InProcessViewMonotone == ~viewBad

\* Across processes: the canonical body never goes back to an older view.
NoRegression == body.seq >= hi

\* A live process's stage file is never removed by a sibling's sweep.
NoLiveStageLoss == ~lostStage

\* A crash never blocks a future persist: every admitted persist of a process
\* that stays alive eventually leaves the pipeline (promoted or superseded).
PersistDrains ==
    \A p \in Procs :
        (alive[p] /\ (pending[p] /= NoReq \/ inflight[p] /= {}))
            ~> (~alive[p] \/ (pending[p] = NoReq /\ inflight[p] = {}))

TypeOK ==
    /\ body.seq \in 0..MaxSeq
    /\ \A p \in Procs : gen[p] \in Nat
=============================================================================
