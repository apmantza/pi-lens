--------------------------- MODULE SnapshotPromotion ---------------------------
(***************************************************************************)
(* Worker-thread persist and promotion of the project snapshot body        *)
(* (clients/project-snapshot.ts, #958 item 2) for ONE project cache dir,   *)
(* shared by N pi-lens processes (a pi session and the MCP server, or two  *)
(* pi sessions in one checkout).                                           *)
(*                                                                         *)
(* Actors, per process p:                                                  *)
(*  - Advance(p): p's view of the tree moves to a newer seq                *)
(*    (runtime.projectSeq; views only grow inside one process).            *)
(*  - Save(p): saveProjectSnapshot (~1780-1880). Admission writes the      *)
(*    meta sidecar FIRST when the durable meta's seq differs (~1815),      *)
(*    picks the generation (same seq -> same generation, ~1849-1854), and  *)
(*    dispatches, or queues behind the one active persist for the key      *)
(*    (~1867-1875, _activeSnapshotPersists / _queuedSnapshotPersists).     *)
(*  - Stage(p, r): the worker (gzip-stage-write.ts writeGzipStageFile)     *)
(*    renames its tmp to the per-generation stage file                     *)
(*    `<gz>.stage-<pid>-<gen>`. A same-named stage is replaced.            *)
(*  - Promote(p, r): handleSnapshotWorkerResult (~1474-1580): the          *)
(*    generation gate (~1502), then renameSync(stage, gz) (~1555). A       *)
(*    missing stage (ENOENT) falls back to the synchronous main-thread     *)
(*    writer (~1573-1578), which writes the same body.                     *)
(*  - Finalize(p, r): finalizeProjectSnapshotMeta writes the meta for the  *)
(*    promoted body (~1557-1561), then completeSnapshotPersist dispatches  *)
(*    the queued request.                                                  *)
(*  - Sweep(p): sweepStaleSnapshotStageFiles (~1719-1736), once per        *)
(*    process after its first save, removes every stage file whose name    *)
(*    does not carry p's own pid.                                          *)
(*  - Crash(p): the process dies; its stage files stay on disk.            *)
(*  - SessionReset(p) (mutant only): a session_start that clears the       *)
(*    persist coordinator. The code does not do this: the session-state    *)
(*    registry pins it as process-lifetime state.                          *)
(*                                                                         *)
(* A body is identified by (owner process, per-process save ordinal ver,   *)
(* view seq). Readers are not actors: every reader loads whatever `body`   *)
(* and `meta` say, and both are replaced by rename, so a reader never sees *)
(* a partial file (TornRead is not a reachable state in this encoding;     *)
(* see README).                                                            *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS
    Procs,          \* process ids (model values)
    MaxSeq,         \* largest view seq
    MaxSaves,       \* saves per process
    GenGate,        \* today TRUE: the generation gate at promotion
    SingleActive,   \* today TRUE: one active persist per key, the rest queue
    SweepLiveness,  \* today FALSE: the sweep skips stage files of live pids
    PromoteCAS,     \* candidate fix: promote only if meta.seq <= own seq
    AdmissionCAS,   \* candidate fix: admission meta write only if it raises meta
    CASAtomic,      \* candidate fix: check + rename + meta under one lock
    AllowCrash,     \* a process may die
    SessionReset,   \* mutant: session_start clears the coordinator
    RefuseAll       \* mutant: the promotion refuses every save

NoReq == [none |-> TRUE]
Phases == {"posted", "staged", "checked", "renamed"}

VARIABLES
    view,       \* view[p]: p's current tree view (seq)
    alive,      \* alive[p]
    saves,      \* saves[p]: saves so far (also the next ver)
    genSeq,     \* genSeq[p]: [g, s], _snapshotGenerationStates entry
    active,     \* active[p]: set of in-flight requests
    queued,     \* queued[p]: NoReq or one request
    swept,      \* swept[p]: the once-per-process sweep has run
    stages,     \* stage files on disk: set of [p, g, ver, seq]
    body,       \* canonical body: [p, ver, seq]
    meta,       \* meta sidecar seq
    hi,         \* history: highest body seq ever promoted
    promoted,   \* history: promoted[p] = highest ver p has put in `body`
    inprocBad,  \* history: p put an older ver over a newer one of its own
    lostStage,  \* history: a live process found its own stage removed
    staleProm,  \* history: p promoted a seq older than its latest admitted one
    lastSaved   \* history: lastSaved[p] = the view seq of p's latest save

vars == <<view, alive, saves, genSeq, active, queued, swept, stages, body,
          meta, hi, promoted, inprocBad, lostStage, staleProm, lastSaved>>

Init ==
    /\ view = [p \in Procs |-> 1]
    /\ alive = [p \in Procs |-> TRUE]
    /\ saves = [p \in Procs |-> 0]
    /\ genSeq = [p \in Procs |-> [g |-> 0, s |-> 0]]
    /\ active = [p \in Procs |-> {}]
    /\ queued = [p \in Procs |-> NoReq]
    /\ swept = [p \in Procs |-> FALSE]
    /\ stages = {}
    /\ body = [p |-> "init", ver |-> 0, seq |-> 0]
    /\ meta = 0
    /\ hi = 0
    /\ promoted = [p \in Procs |-> 0]
    /\ inprocBad = FALSE
    /\ lostStage = FALSE
    /\ staleProm = FALSE
    /\ lastSaved = [p \in Procs |-> 0]

StageName(s) == <<s.p, s.g>>
HasStage(p, g) == \E s \in stages : s.p = p /\ s.g = g
StageOf(p, g) == CHOOSE s \in stages : s.p = p /\ s.g = g
DropStage(p, g) == {s \in stages : ~(s.p = p /\ s.g = g)}

\* p's main thread is inside handleSnapshotWorkerResult's synchronous
\* rename -> meta section: none of p's other main-thread actions can run
\* until it finishes. Other processes, and p's worker thread, can.
Busy(p) == \E x \in active[p] : x.phase \in {"checked", "renamed"}

Max(a, b) == IF a >= b THEN a ELSE b

\* Put a body into the canonical slot and update the histories.
WriteBody(p, ver, seq) ==
    /\ body' = [p |-> p, ver |-> ver, seq |-> seq]
    /\ hi' = Max(hi, seq)
    /\ inprocBad' = (inprocBad \/ ver < promoted[p])
    /\ promoted' = [promoted EXCEPT ![p] = Max(@, ver)]
    /\ staleProm' = (staleProm \/ seq /= genSeq[p].s)

\* The requests _activeSnapshotPersists still names (a detached one was
\* dropped from it by the SessionReset mutant but is still in the worker).
Blocking(p) == {x \in active[p] : ~x.det}

\* completeSnapshotPersist: drop r; if r is the key's active persist,
\* dispatch the queued request (~1335-1343). A detached request's completion
\* returns early (`_activeSnapshotPersists.get(key) !== pending`).
Complete(p, r) ==
    IF ~r.det /\ queued[p] /= NoReq
    THEN /\ active' = [active EXCEPT ![p] = (@ \ {r}) \union {queued[p]}]
         /\ queued' = [queued EXCEPT ![p] = NoReq]
    ELSE /\ active' = [active EXCEPT ![p] = @ \ {r}]
         /\ UNCHANGED queued

Advance(p) ==
    /\ alive[p] /\ ~Busy(p) /\ view[p] < MaxSeq
    /\ view' = [view EXCEPT ![p] = @ + 1]
    /\ UNCHANGED <<alive, saves, genSeq, active, queued, swept, stages, body,
                   meta, hi, promoted, inprocBad, lostStage, staleProm>>

Save(p) ==
    /\ alive[p] /\ ~Busy(p) /\ saves[p] < MaxSaves
    /\ LET s == view[p]
           g == IF genSeq[p].s = s THEN genSeq[p].g ELSE genSeq[p].g + 1
           r == [ver |-> saves[p] + 1, seq |-> s, g |-> g, phase |-> "posted", det |-> FALSE]
       IN /\ saves' = [saves EXCEPT ![p] = @ + 1]
          /\ lastSaved' = [lastSaved EXCEPT ![p] = s]
          /\ genSeq' = [genSeq EXCEPT ![p] = [g |-> g, s |-> s]]
          \* meta-first for a new seq (~1815)
          /\ meta' = IF meta /= s /\ (~AdmissionCAS \/ meta < s) THEN s ELSE meta
          /\ IF SingleActive /\ Blocking(p) /= {}
             THEN /\ queued' = [queued EXCEPT ![p] = r]
                  /\ UNCHANGED active
             ELSE /\ active' = [active EXCEPT ![p] = @ \union {r}]
                  /\ UNCHANGED queued
    /\ UNCHANGED <<view, alive, swept, stages, body, hi, promoted, inprocBad,
                   lostStage, staleProm>>

Stage(p, r) ==
    /\ alive[p] /\ r \in active[p] /\ r.phase = "posted"
    /\ stages' = DropStage(p, r.g) \union {[p |-> p, g |-> r.g, ver |-> r.ver, seq |-> r.seq]}
    /\ active' = [active EXCEPT ![p] = (@ \ {r}) \union {[r EXCEPT !.phase = "staged"]}]
    /\ UNCHANGED <<view, alive, saves, genSeq, queued, swept, body, meta, hi,
                   promoted, inprocBad, lostStage, staleProm>>

\* The body the promotion writes: the stage file if it is there (rename), or
\* r's own snapshot through the sync fallback writer when it is gone.
PromotedBody(p, r) ==
    IF HasStage(p, r.g) THEN StageOf(p, r.g)
    ELSE [p |-> p, g |-> r.g, ver |-> r.ver, seq |-> r.seq]

Superseded(p, r) == GenGate /\ genSeq[p].g /= r.g
CASRefuses(r) == PromoteCAS /\ (RefuseAll \/ meta > r.seq)

Promote(p, r) ==
    /\ alive[p] /\ ~Busy(p) /\ r \in active[p] /\ r.phase = "staged"
    /\ IF Superseded(p, r)
       THEN \* stale stage removed, request completed (~1502-1510)
            /\ stages' = DropStage(p, r.g)
            /\ Complete(p, r)
            /\ UNCHANGED <<body, meta, hi, promoted, inprocBad, lostStage, staleProm>>
       ELSE IF PromoteCAS /\ ~CASAtomic
       THEN \* check now, rename in a later step (no lock)
            IF CASRefuses(r)
            THEN /\ stages' = DropStage(p, r.g)
                 /\ Complete(p, r)
                 /\ UNCHANGED <<body, meta, hi, promoted, inprocBad, lostStage, staleProm>>
            ELSE /\ active' = [active EXCEPT ![p] = (@ \ {r}) \union {[r EXCEPT !.phase = "checked"]}]
                 /\ UNCHANGED <<stages, queued, body, meta, hi, promoted, inprocBad, lostStage, staleProm>>
       ELSE IF CASRefuses(r)
       THEN /\ stages' = DropStage(p, r.g)
            /\ Complete(p, r)
            /\ UNCHANGED <<body, meta, hi, promoted, inprocBad, lostStage, staleProm>>
       ELSE LET b == PromotedBody(p, r) IN
            /\ WriteBody(p, b.ver, b.seq)
            /\ lostStage' = (lostStage \/ ~HasStage(p, r.g))
            /\ stages' = DropStage(p, r.g)
            /\ IF PromoteCAS /\ CASAtomic
               THEN \* rename and meta under the lock, one step
                    /\ meta' = b.seq
                    /\ Complete(p, r)
               ELSE /\ active' = [active EXCEPT ![p] = (@ \ {r}) \union {[r EXCEPT !.phase = "renamed"]}]
                    /\ UNCHANGED <<meta, queued>>
    /\ UNCHANGED <<view, alive, saves, genSeq, swept>>

\* Unlocked CAS mutant: the rename after the separate check.
RenameChecked(p, r) ==
    /\ alive[p] /\ r \in active[p] /\ r.phase = "checked"
    /\ LET b == PromotedBody(p, r) IN
       /\ WriteBody(p, b.ver, b.seq)
       /\ lostStage' = (lostStage \/ ~HasStage(p, r.g))
       /\ stages' = DropStage(p, r.g)
       /\ active' = [active EXCEPT ![p] = (@ \ {r}) \union {[r EXCEPT !.phase = "renamed"]}]
    /\ UNCHANGED <<view, alive, saves, genSeq, queued, swept, meta>>

Finalize(p, r) ==
    /\ alive[p] /\ r \in active[p] /\ r.phase = "renamed"
    /\ meta' = r.seq
    /\ Complete(p, r)
    /\ UNCHANGED <<view, alive, saves, genSeq, swept, stages, body, hi,
                   promoted, inprocBad, lostStage, staleProm>>

Sweep(p) ==
    /\ alive[p] /\ ~Busy(p) /\ ~swept[p] /\ saves[p] > 0
    /\ swept' = [swept EXCEPT ![p] = TRUE]
    /\ stages' = {s \in stages : s.p = p \/ (SweepLiveness /\ alive[s.p])}
    /\ UNCHANGED <<view, alive, saves, genSeq, active, queued, body, meta, hi,
                   promoted, inprocBad, lostStage, staleProm>>

Crash(p) ==
    /\ AllowCrash /\ alive[p]
    /\ alive' = [alive EXCEPT ![p] = FALSE]
    /\ active' = [active EXCEPT ![p] = {}]
    /\ queued' = [queued EXCEPT ![p] = NoReq]
    /\ UNCHANGED <<view, saves, genSeq, swept, stages, body, meta, hi,
                   promoted, inprocBad, lostStage, staleProm>>

\* Mutant: a session_start that clears _snapshotGenerationStates and
\* _activeSnapshotPersists but not _snapshotWorkerRequests: the in-flight
\* request can still promote, but no longer blocks the new session's saves.
Reset(p) ==
    /\ SessionReset /\ alive[p] /\ ~Busy(p)
    /\ genSeq' = [genSeq EXCEPT ![p] = [g |-> 0, s |-> 0]]
    /\ active' = [active EXCEPT ![p] = {[x EXCEPT !.det = TRUE] : x \in @}]
    /\ UNCHANGED <<view, alive, saves, queued, swept, stages, body,
                   meta, hi, promoted, inprocBad, lostStage, staleProm>>

Next ==
    \E p \in Procs :
        \/ Save(p)
        \/ /\ \/ Advance(p) \/ Sweep(p) \/ Crash(p) \/ Reset(p)
              \/ \E r \in active[p] :
                    Stage(p, r) \/ Promote(p, r) \/ RenameChecked(p, r) \/ Finalize(p, r)
           /\ UNCHANGED lastSaved

Spec == Init /\ [][Next]_vars

(***************************************************************************)
(* Invariants                                                              *)
(***************************************************************************)
\* Shape 21 inside one process: a process never puts one of its own older
\* saves over a newer one it already promoted.
InProcessLatestWins == ~inprocBad

\* Shape 21 across processes: the canonical body never goes back to an older
\* tree view than one already promoted.
NoRegression == body.seq >= hi

\* project-snapshot.ts ~1797-1808: meta-first ordering exists so the meta is
\* never BEHIND the body ("an old-seq meta sitting over a freshly written body
\* ... throwing away a genuinely fresh snapshot").
MetaNotBehindBody == meta >= body.seq

\* A live process's staged body is never removed by someone else before it
\* promotes it (a removal forces the synchronous main-thread gzip, the
\* degraded +656MB path, ~1573-1578).
NoLiveStageLoss == lostStage = FALSE

\* The generation gate's promise (~1498-1510, #1322): a process never
\* promotes a view it has already superseded by a newer admitted save, not
\* even transiently.
NoSupersededPromotion == staleProm = FALSE

\* No drop (catalog shape 54): once every live process is idle, the body is
\* at least as new as each live process's latest save. A save refused by the
\* compare-and-set was older than a body that landed or will land.
Quiescent == \A p \in Procs : alive[p] => (active[p] = {} /\ queued[p] = NoReq)
NoDrop == Quiescent => \A p \in Procs : alive[p] => body.seq >= lastSaved[p]

TypeOK ==
    /\ meta \in 0..MaxSeq
    /\ body.seq \in 0..MaxSeq
=============================================================================
