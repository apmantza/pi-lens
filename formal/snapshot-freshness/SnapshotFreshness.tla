-------------------------- MODULE SnapshotFreshness --------------------------
(***************************************************************************)
(* Seq-keyed freshness of the project snapshot when more than one process  *)
(* records mutations for one project.                                      *)
(*                                                                         *)
(* Actors, per process p:                                                  *)
(*  - Seed(p): session_start replays the change log                        *)
(*    (project-changes.ts readLatestProjectSequence) and seeds             *)
(*    runtime.projectSeq (runtime-coordinator.ts seedProjectSequence ~835).*)
(*  - Edit(p): recordProjectMutation (~644-690) bumps the IN-MEMORY        *)
(*    projectSeq (bumpFileSeq ~854-868: `this._projectSeq += 1`) and       *)
(*    appends {seq, file} to the shared change-log.jsonl.                  *)
(*  - Save(p): saveRuntimeProjectSnapshot stamps the snapshot with         *)
(*    runtime.projectSeq and the runtime's sequence index (~2037-2053).    *)
(*    The promotion itself is taken as atomic here; SnapshotPromotion.tla  *)
(*    covers its ordering.                                                 *)
(*                                                                         *)
(* Readers: session_start judges the snapshot fresh iff snapshot.seq ==    *)
(* the log's max seq (isProjectSnapshotFresh) and uses the meta's          *)
(* sequenceIndex as the base of the bounded replay, skipping every log     *)
(* entry with seq <= snapshot.seq (partialReplay, ~188-207).               *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS
    Procs,
    MaxEdits,       \* edits in total
    LogAlloc,       \* candidate fix: seq = max(log max, own seq) + 1, under the append lock
    CompleteStamp   \* candidate fix: stamp a fresh seq only if every logged entry
                    \* at or below it is in the runtime's own view; else a
                    \* never-fresh stamp

Never == 999

VARIABLES
    log,     \* set of [seq, e]
    seq,     \* seq[p]: runtime.projectSeq
    known,   \* known[p]: edit ids p's runtime has folded
    snap,    \* [seq, known]: the canonical snapshot
    nextE

vars == <<log, seq, known, snap, nextE>>

LogMax == IF log = {} THEN 0 ELSE CHOOSE m \in {x.seq : x \in log} : \A x \in log : x.seq <= m
Upto(s) == {x.e : x \in {y \in log : y.seq <= s}}

Init ==
    /\ log = {}
    /\ seq = [p \in Procs |-> 0]
    /\ known = [p \in Procs |-> {}]
    /\ snap = [seq |-> Never, known |-> {}]
    /\ nextE = 1

Seed(p) ==
    /\ seq' = [seq EXCEPT ![p] = LogMax]
    /\ known' = [known EXCEPT ![p] = {x.e : x \in log}]
    /\ UNCHANGED <<log, snap, nextE>>

Edit(p) ==
    /\ nextE <= MaxEdits
    /\ LET s == IF LogAlloc THEN (IF LogMax > seq[p] THEN LogMax ELSE seq[p]) + 1
                ELSE seq[p] + 1
       IN /\ log' = log \union {[seq |-> s, e |-> nextE]}
          /\ seq' = [seq EXCEPT ![p] = s]
    /\ known' = [known EXCEPT ![p] = @ \union {nextE}]
    /\ nextE' = nextE + 1
    /\ UNCHANGED snap

Save(p) ==
    /\ snap' = [seq |-> IF CompleteStamp /\ ~(Upto(seq[p]) \subseteq known[p])
                        THEN Never ELSE seq[p],
                known |-> known[p]]
    /\ UNCHANGED <<log, seq, known, nextE>>

Next == \E p \in Procs : Seed(p) \/ Edit(p) \/ Save(p)
Spec == Init /\ [][Next]_vars

\* A snapshot a session_start would judge fresh reflects every logged edit.
FreshMeansComplete ==
    snap.seq = LogMax => {x.e : x \in log} \subseteq snap.known

\* The bounded replay (meta sequenceIndex + entries with seq > snap.seq)
\* equals the full replay: nothing at or below snap.seq is outside the base.
BoundedReplayExact ==
    snap.seq /= Never => Upto(snap.seq) \subseteq snap.known

\* A process whose own seq matches the snapshot's is not served a snapshot
\* missing one of its own edits.
FreshForOwnRuntime ==
    \A p \in Procs : snap.seq = seq[p] => known[p] \subseteq snap.known
=============================================================================
