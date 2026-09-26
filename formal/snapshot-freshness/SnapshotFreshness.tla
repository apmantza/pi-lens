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
(*    entry and is complete again, and its fold point (the number of log   *)
(*    entries it folded, `logEntries`) moves to the end of the log.        *)
(*  - ColdSeed(p): a timed-out sequence read seeds projectSeq 0 with an    *)
(*    empty view and fold point 0 (runtime-session.ts, #1162).             *)
(*  - Edit(p): recordProjectMutation, under the change-log lock:           *)
(*    appendProjectChangeAllocated reads the log's max seq; bumpFileSeq    *)
(*    allocates max(log max, own seq) + 1 (LogAlloc) and, when the log max *)
(*    is above the runtime's own seq, records the entries it never folded  *)
(*    (CompleteStamp: missing[p] is the highest such seq).                 *)
(*  - UnlockedRead(p) then UnlockedAppend(p) (UnlockedEdits): the same     *)
(*    edit when the change-log lock stays held past its wait. The read of  *)
(*    the log's max and the append are two steps, and every other process  *)
(*    may act between them, so the seq may collide. The entry is tagged    *)
(*    `unlocked` in the log (review round 2, R2-F1).                       *)
(*  - Save(p): saveRuntimeProjectSnapshot stamps runtime.projectSeq, the   *)
(*    runtime's view, its fold point, and `incomplete` when missing[p] > 0.*)
(*    Promotion is the compare-and-set of SnapshotPromotion.tla: the body  *)
(*    lands unless the canonical one is at a higher seq (SeqCAS).          *)
(*                                                                         *)
(* Readers: session_start judges the snapshot fresh iff it is not          *)
(* incomplete, snapshot.seq == the log's max seq, and the reader rule      *)
(* finds no sign of an unlocked collision (ReaderRule):                    *)
(*  - "tag":  no unlocked entry sits after the snapshot's fold point (the  *)
(*            code);                                                       *)
(*  - "dup":  no second entry shares the snapshot's seq (the review's      *)
(*            first prescription, kept as a mutant);                       *)
(*  - "none": no check (the code before round 2).                          *)
(* The same rule decides whether the meta's sequenceIndex may seed the     *)
(* bounded replay, which skips every log entry with seq <= snapshot.seq.   *)
(***************************************************************************)
EXTENDS Integers, FiniteSets

CONSTANTS
    Procs,
    MaxEdits,         \* edits in total
    LogAlloc,         \* seq = max(log max, own seq) + 1, under the append lock
    CompleteStamp,    \* a view that missed a logged entry stamps `incomplete`
    SeqCAS,           \* promotion is a compare-and-set on seq (#3509)
    ColdSeeds,        \* a session_start sequence read may time out
    UnlockedEdits,    \* the change-log lock may time out: unlocked appends
    ReaderRule,       \* "tag" (the code), "dup" or "none" (mutants)
    NeverSeqMutant,   \* mutant: the first #3511 design, an incomplete view
                      \* stamped seq -1, so the compare-and-set ranks it
                      \* below every stamped snapshot
    RefuseAllMutant,  \* mutant: the promotion refuses every save
    AlwaysIncompleteMutant \* mutant: every save is stamped incomplete

Never == -1
NoPend == -1

VARIABLES
    log,      \* set of [seq, e, pos, unl]; pos is the append order
    seq,      \* seq[p]: runtime.projectSeq
    known,    \* known[p]: edit ids p's runtime has folded
    missing,  \* missing[p]: highest logged seq p's view missed (0 = none)
    fold,     \* fold[p]: log entries p folded at its last seed or merge
    pend,     \* pend[p]: the log max an unlocked append read, or NoPend
    snap,     \* [seq, known, inc, fold]: the canonical snapshot
    hiSaved,  \* history: highest view seq any process has saved
    nextE

vars == <<log, seq, known, missing, fold, pend, snap, hiSaved, nextE>>

Max(a, b) == IF a >= b THEN a ELSE b
LogMax == IF log = {} THEN 0 ELSE CHOOSE m \in {x.seq : x \in log} : \A x \in log : x.seq <= m
LogLen == Cardinality(log)
Upto(s) == {x.e : x \in {y \in log : y.seq <= s}}
AllEdits == {x.e : x \in log}
Idle(p) == pend[p] = NoPend

\* The reader's verdict on the canonical snapshot: a sign that a collision
\* may hide an entry the snapshot's runtime never folded.
Suspect ==
    CASE ReaderRule = "tag" -> \E x \in log : x.unl /\ x.pos > snap.fold
      [] ReaderRule = "dup" -> Cardinality({x \in log : x.seq = snap.seq}) >= 2
      [] OTHER -> FALSE

Init ==
    /\ log = {}
    /\ seq = [p \in Procs |-> 0]
    /\ known = [p \in Procs |-> {}]
    /\ missing = [p \in Procs |-> 0]
    /\ fold = [p \in Procs |-> 0]
    /\ pend = [p \in Procs |-> NoPend]
    /\ snap = [seq |-> 0, known |-> {}, inc |-> FALSE, fold |-> 0]
    /\ hiSaved = 0
    /\ nextE = 1

Seed(p) ==
    /\ Idle(p)
    /\ seq' = [seq EXCEPT ![p] = Max(LogMax, @)]
    /\ known' = [known EXCEPT ![p] = @ \union AllEdits]
    /\ missing' = [missing EXCEPT ![p] = 0]
    /\ fold' = [fold EXCEPT ![p] = LogLen]
    /\ UNCHANGED <<log, pend, snap, hiSaved, nextE>>

ColdSeed(p) ==
    /\ ColdSeeds
    /\ Idle(p)
    /\ seq' = [seq EXCEPT ![p] = 0]
    /\ known' = [known EXCEPT ![p] = {}]
    /\ missing' = [missing EXCEPT ![p] = 0]
    /\ fold' = [fold EXCEPT ![p] = 0]
    /\ UNCHANGED <<log, pend, snap, hiSaved, nextE>>

\* Append edit nextE at seq s, having read log max `readMax`.
Append(p, readMax, unl) ==
    /\ nextE <= MaxEdits
    /\ LET s == IF LogAlloc THEN Max(readMax, seq[p]) + 1 ELSE seq[p] + 1
       IN /\ log' = log \union {[seq |-> s, e |-> nextE, pos |-> LogLen + 1, unl |-> unl]}
          /\ seq' = [seq EXCEPT ![p] = s]
    /\ missing' = [missing EXCEPT ![p] =
                     IF CompleteStamp /\ readMax > seq[p] THEN Max(@, readMax) ELSE @]
    /\ known' = [known EXCEPT ![p] = @ \union {nextE}]
    /\ nextE' = nextE + 1

Edit(p) ==
    /\ Idle(p)
    /\ Append(p, LogMax, FALSE)
    /\ UNCHANGED <<fold, pend, snap, hiSaved>>

UnlockedRead(p) ==
    /\ UnlockedEdits
    /\ Idle(p)
    /\ nextE <= MaxEdits
    /\ pend' = [pend EXCEPT ![p] = LogMax]
    /\ UNCHANGED <<log, seq, known, missing, fold, snap, hiSaved, nextE>>

UnlockedAppend(p) ==
    /\ ~Idle(p)
    /\ Append(p, pend[p], TRUE)
    /\ pend' = [pend EXCEPT ![p] = NoPend]
    /\ UNCHANGED <<fold, snap, hiSaved>>

Save(p) ==
    /\ Idle(p)
    /\ LET inc == AlwaysIncompleteMutant \/ missing[p] > 0
           stamp == IF NeverSeqMutant /\ inc THEN Never ELSE seq[p]
           lands == ~RefuseAllMutant /\ (~SeqCAS \/ snap.seq <= stamp)
       IN snap' = IF lands
                  THEN [seq |-> stamp, known |-> known[p],
                        inc |-> inc /\ ~NeverSeqMutant, fold |-> fold[p]]
                  ELSE snap
    /\ hiSaved' = Max(hiSaved, seq[p])
    /\ UNCHANGED <<log, seq, known, missing, fold, pend, nextE>>

Next == \E p \in Procs :
    Seed(p) \/ ColdSeed(p) \/ Edit(p) \/ UnlockedRead(p) \/ UnlockedAppend(p) \/ Save(p)
Spec == Init /\ [][Next]_vars

\* What session_start would judge fresh against a runtime seq s.
FreshAt(s) == snap.seq = s /\ ~snap.inc /\ ~Suspect

\* A snapshot a session_start would judge fresh reflects every logged edit.
FreshMeansComplete == FreshAt(LogMax) => AllEdits \subseteq snap.known

\* The bounded replay (the sequenceIndex of a trusted complete snapshot plus
\* the entries with seq > snap.seq) equals the full replay.
BoundedReplayExact ==
    (~snap.inc /\ snap.seq # Never /\ ~Suspect) => Upto(snap.seq) \subseteq snap.known

\* A process whose own seq matches the snapshot's is not served a snapshot
\* missing one of its own edits.
FreshForOwnRuntime ==
    \A p \in Procs : FreshAt(seq[p]) => known[p] \subseteq snap.known

\* No drop (catalog shape 54): the canonical snapshot is never behind the
\* newest view any process saved. An incomplete view still lands.
NewestSaveLands == snap.seq >= hiSaved

\* The incomplete marker is set only on a view that really missed a logged
\* entry at or below its seq; a complete view is never withheld from
\* freshness.
IncompleteOnlyWhenMissing ==
    snap.inc => ~(Upto(snap.seq) \subseteq snap.known)
=============================================================================
