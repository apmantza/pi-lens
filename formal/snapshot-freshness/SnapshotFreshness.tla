-------------------------- MODULE SnapshotFreshness --------------------------
(***************************************************************************)
(* Seq-keyed freshness of the project snapshot when more than one process  *)
(* records mutations for one project.                                      *)
(*                                                                         *)
(* Actors, per process p:                                                  *)
(*  - Seed(p): session_start replays the change log                        *)
(*    (project-changes.ts readLatestProjectSequence) and seeds             *)
(*    runtime.projectSeq (runtime-coordinator.ts seedProjectSequence), or  *)
(*    the deferred read after a timed-out one folds into the runtime       *)
(*    (mergeProjectSequence). Either way the view then holds every logged  *)
(*    entry and is complete again.                                         *)
(*  - ColdSeed(p): a timed-out sequence read seeds projectSeq 0 with an    *)
(*    empty view (runtime-session.ts, #1162).                              *)
(*  - Edit(p): recordProjectMutation, under the change-log lock:           *)
(*    appendProjectChangeAllocated reads the log's max seq; bumpFileSeq    *)
(*    allocates max(log max, own seq) + 1 (LogAlloc) and, when the log max *)
(*    is above the runtime's own seq, records the entries it never folded  *)
(*    (CompleteStamp: missing[p] is the highest such seq).                 *)
(*  - Save(p): saveRuntimeProjectSnapshot stamps runtime.projectSeq, the   *)
(*    runtime's view, and `incomplete` when missing[p] > 0. Promotion is   *)
(*    the compare-and-set of SnapshotPromotion.tla: the body lands unless  *)
(*    the canonical one is at a higher seq (SeqCAS). Its ordering inside   *)
(*    and across processes is that model's subject; here it is atomic.     *)
(*                                                                         *)
(* Readers: session_start judges the snapshot fresh iff it is not          *)
(* incomplete and snapshot.seq == the log's max seq (isProjectSnapshotFresh)*)
(* and uses the meta's sequenceIndex (embedded only in a complete          *)
(* snapshot) as the base of the bounded replay, skipping every log entry   *)
(* with seq <= snapshot.seq (partialReplay).                               *)
(***************************************************************************)
EXTENDS Integers, FiniteSets

CONSTANTS
    Procs,
    MaxEdits,         \* edits in total
    LogAlloc,         \* seq = max(log max, own seq) + 1, under the append lock
    CompleteStamp,    \* a view that missed a logged entry stamps `incomplete`
    SeqCAS,           \* promotion is a compare-and-set on seq (#3509)
    ColdSeeds,        \* a session_start sequence read may time out
    NeverSeqMutant,   \* mutant: the first #3511 design, an incomplete view
                      \* stamped seq -1, so the compare-and-set ranks it
                      \* below every stamped snapshot
    RefuseAllMutant,  \* mutant: the promotion refuses every save
    AlwaysIncompleteMutant \* mutant: every save is stamped incomplete

Never == -1

VARIABLES
    log,      \* set of [seq, e]
    seq,      \* seq[p]: runtime.projectSeq
    known,    \* known[p]: edit ids p's runtime has folded
    missing,  \* missing[p]: highest logged seq p's view missed (0 = none)
    snap,     \* [seq, known, inc]: the canonical snapshot
    hiSaved,  \* history: highest view seq any process has saved
    nextE

vars == <<log, seq, known, missing, snap, hiSaved, nextE>>

Max(a, b) == IF a >= b THEN a ELSE b
LogMax == IF log = {} THEN 0 ELSE CHOOSE m \in {x.seq : x \in log} : \A x \in log : x.seq <= m
Upto(s) == {x.e : x \in {y \in log : y.seq <= s}}
AllEdits == {x.e : x \in log}

Init ==
    /\ log = {}
    /\ seq = [p \in Procs |-> 0]
    /\ known = [p \in Procs |-> {}]
    /\ missing = [p \in Procs |-> 0]
    /\ snap = [seq |-> 0, known |-> {}, inc |-> FALSE]
    /\ hiSaved = 0
    /\ nextE = 1

Seed(p) ==
    /\ seq' = [seq EXCEPT ![p] = Max(LogMax, @)]
    /\ known' = [known EXCEPT ![p] = @ \union AllEdits]
    /\ missing' = [missing EXCEPT ![p] = 0]
    /\ UNCHANGED <<log, snap, hiSaved, nextE>>

ColdSeed(p) ==
    /\ ColdSeeds
    /\ seq' = [seq EXCEPT ![p] = 0]
    /\ known' = [known EXCEPT ![p] = {}]
    /\ missing' = [missing EXCEPT ![p] = 0]
    /\ UNCHANGED <<log, snap, hiSaved, nextE>>

Edit(p) ==
    /\ nextE <= MaxEdits
    /\ LET s == IF LogAlloc THEN Max(LogMax, seq[p]) + 1 ELSE seq[p] + 1
       IN /\ log' = log \union {[seq |-> s, e |-> nextE]}
          /\ seq' = [seq EXCEPT ![p] = s]
    /\ missing' = [missing EXCEPT ![p] =
                     IF CompleteStamp /\ LogMax > seq[p] THEN Max(@, LogMax) ELSE @]
    /\ known' = [known EXCEPT ![p] = @ \union {nextE}]
    /\ nextE' = nextE + 1
    /\ UNCHANGED <<snap, hiSaved>>

Save(p) ==
    /\ LET inc == AlwaysIncompleteMutant \/ missing[p] > 0
           stamp == IF NeverSeqMutant /\ inc THEN Never ELSE seq[p]
           lands == ~RefuseAllMutant /\ (~SeqCAS \/ snap.seq <= stamp)
       IN snap' = IF lands
                  THEN [seq |-> stamp, known |-> known[p],
                        inc |-> inc /\ ~NeverSeqMutant]
                  ELSE snap
    /\ hiSaved' = Max(hiSaved, seq[p])
    /\ UNCHANGED <<log, seq, known, missing, nextE>>

Next == \E p \in Procs : Seed(p) \/ ColdSeed(p) \/ Edit(p) \/ Save(p)
Spec == Init /\ [][Next]_vars

\* A snapshot a session_start would judge fresh reflects every logged edit.
FreshMeansComplete ==
    (snap.seq = LogMax /\ ~snap.inc) => AllEdits \subseteq snap.known

\* The bounded replay (the sequenceIndex of a complete snapshot plus entries
\* with seq > snap.seq) equals the full replay.
BoundedReplayExact ==
    (~snap.inc /\ snap.seq # Never) => Upto(snap.seq) \subseteq snap.known

\* A process whose own seq matches the snapshot's is not served a snapshot
\* missing one of its own edits.
FreshForOwnRuntime ==
    \A p \in Procs : (snap.seq = seq[p] /\ ~snap.inc) => known[p] \subseteq snap.known

\* No drop (catalog shape 54): the canonical snapshot is never behind the
\* newest view any process saved. An incomplete view still lands.
NewestSaveLands == snap.seq >= hiSaved

\* The incomplete marker is set only on a view that really missed a logged
\* entry at or below its seq; a complete view is never withheld from
\* freshness.
IncompleteOnlyWhenMissing ==
    snap.inc => ~(Upto(snap.seq) \subseteq snap.known)
=============================================================================
