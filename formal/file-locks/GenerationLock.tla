---------------------------- MODULE GenerationLock ----------------------------
(***************************************************************************)
(* Candidate redesign for the pid-file locks in FileLock.tla, #3447.       *)
(*                                                                         *)
(* The lock is a series of files lock.1, lock.2, ... in one directory.     *)
(* The holder is whoever created the highest generation, and that file is  *)
(* not released or stale. Taking the lock, including a stale takeover, is  *)
(* an exclusive create of the next generation. No step removes a lock by   *)
(* path, so no step can remove a lock it did not judge.                    *)
(*                                                                         *)
(*  - acquire: list the directory, take the highest generation g; if it is *)
(*    free (released, owner dead, or aged out), create lock.(g+1) with     *)
(*    "wx" from a fully written temp file (link), then list again and back *)
(*    off if a higher generation exists (a stale listing can re-create a   *)
(*    name that cleanup removed).                                          *)
(*  - release: create the marker lock.g.released.                          *)
(*  - cleanup: a holder may delete generations below its predecessor.      *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets, TLC

CONSTANTS
    Procs,
    MaxCrashes,
    AllowExpiry,    \* a live holder may outlive the stale threshold
    MaxGen,         \* bound on generations, to keep the state space finite
    Cleanup,        \* holders delete generations below their predecessor
    Recheck,        \* the post-create listing; FALSE shows why it is needed
    Rounds          \* acquisitions per writer

Gens == 1..MaxGen
None == 0

VARIABLES
    pc,
    alive,
    exists,     \* exists[g]: lock.g is present
    owner,      \* owner[g]: the process that last created lock.g
    released,   \* released[g]: lock.g.released is present
    expired,    \* expired[g]: lock.g's mtime is past the stale threshold
    view,       \* the highest generation this process's listing saw
    mine,       \* the generation this process created
    reg,
    snap,
    committed,
    crashes,
    rounds      \* acquisitions this writer has completed

vars == <<pc, alive, exists, owner, released, expired, view, mine, reg, snap, committed, crashes, rounds>>

CS == {"cs_read", "cs_write"}

Top == IF \E g \in Gens : exists[g]
         THEN CHOOSE g \in Gens : exists[g] /\ \A h \in Gens : exists[h] => h <= g
         ELSE None

Init ==
    /\ pc = [p \in Procs |-> "list"]
    /\ alive = [p \in Procs |-> TRUE]
    /\ exists = [g \in Gens |-> FALSE]
    /\ owner = [g \in Gens |-> CHOOSE p \in Procs : TRUE]
    /\ released = [g \in Gens |-> FALSE]
    /\ expired = [g \in Gens |-> FALSE]
    /\ view = [p \in Procs |-> None]
    /\ mine = [p \in Procs |-> None]
    /\ reg = {}
    /\ snap = [p \in Procs |-> {}]
    /\ committed = [p \in Procs |-> FALSE]
    /\ crashes = 0
    /\ rounds = [p \in Procs |-> 0]

List(p) ==
    /\ pc[p] = "list"
    /\ view' = [view EXCEPT ![p] = Top]
    /\ pc' = [pc EXCEPT ![p] = "judge"]
    /\ UNCHANGED <<alive, exists, owner, released, expired, mine, reg, snap, committed, crashes, rounds>>

\* A generation removed by cleanup since the listing reads as free: the create
\* that follows then fails, or the recheck catches it.
Free(g) ==
    \/ g = None
    \/ ~exists[g]
    \/ released[g]
    \/ expired[g]
    \/ ~alive[owner[g]]

Judge(p) ==
    /\ pc[p] = "judge"
    /\ pc' = [pc EXCEPT ![p] = IF Free(view[p]) THEN "create" ELSE "list"]
    /\ UNCHANGED <<alive, exists, owner, released, expired, view, mine, reg, snap, committed, crashes, rounds>>

GiveUp(p) ==
    /\ pc[p] \in {"list", "judge"}
    /\ pc' = [pc EXCEPT ![p] = "timeout"]
    /\ UNCHANGED <<alive, exists, owner, released, expired, view, mine, reg, snap, committed, crashes, rounds>>

\* Exclusive create (link from a written temp file): fails if lock.(v+1) exists.
Create(p) ==
    /\ pc[p] = "create"
    /\ LET g == view[p] + 1 IN
         IF g <= MaxGen /\ ~exists[g]
           THEN /\ exists' = [exists EXCEPT ![g] = TRUE]
                /\ owner' = [owner EXCEPT ![g] = p]
                /\ released' = [released EXCEPT ![g] = FALSE]
                /\ expired' = [expired EXCEPT ![g] = FALSE]
                /\ mine' = [mine EXCEPT ![p] = g]
                /\ pc' = [pc EXCEPT ![p] = IF Recheck THEN "recheck" ELSE "cs_read"]
           ELSE /\ pc' = [pc EXCEPT ![p] = "list"]
                /\ UNCHANGED <<exists, owner, released, expired, mine>>
    /\ UNCHANGED <<alive, view, reg, snap, committed, crashes, rounds>>

Recheck_(p) ==
    /\ pc[p] = "recheck"
    /\ IF \E h \in Gens : h > mine[p] /\ exists[h]
         THEN /\ released' = [released EXCEPT ![mine[p]] = TRUE]
              /\ pc' = [pc EXCEPT ![p] = "list"]
         ELSE /\ pc' = [pc EXCEPT ![p] = "cs_read"]
              /\ UNCHANGED released
    /\ UNCHANGED <<alive, exists, owner, expired, view, mine, reg, snap, committed, crashes, rounds>>

CsRead(p) ==
    /\ pc[p] = "cs_read"
    /\ snap' = [snap EXCEPT ![p] = reg]
    /\ pc' = [pc EXCEPT ![p] = "cs_write"]
    /\ UNCHANGED <<alive, exists, owner, released, expired, view, mine, reg, committed, crashes, rounds>>

CsWrite(p) ==
    /\ pc[p] = "cs_write"
    /\ reg' = snap[p] \cup {p}
    /\ committed' = [committed EXCEPT ![p] = TRUE]
    /\ pc' = [pc EXCEPT ![p] = "release"]
    /\ UNCHANGED <<alive, exists, owner, released, expired, view, mine, snap, crashes, rounds>>

\* Writers acquire again after each release, up to Rounds (every heartbeat is
\* a registry write), so generations advance and cleanup has work to do.
\* The marker names the generation, not the file: if cleanup removed lock.g and
\* a stale listing re-created it, this marks the re-created one.
Release(p) ==
    /\ pc[p] = "release"
    /\ released' = [released EXCEPT ![mine[p]] = TRUE]
    /\ rounds' = [rounds EXCEPT ![p] = @ + 1]
    /\ pc' = [pc EXCEPT ![p] = IF rounds[p] + 1 < Rounds THEN "list" ELSE "done"]
    /\ UNCHANGED <<alive, exists, owner, expired, view, mine, reg, snap, committed, crashes>>

\* A holder deletes one generation below its predecessor.
Clean(p) ==
    /\ Cleanup
    /\ pc[p] \in CS
    /\ \E g \in Gens :
         /\ g + 1 < mine[p]
         /\ exists[g]
         /\ exists' = [exists EXCEPT ![g] = FALSE]
         /\ released' = [released EXCEPT ![g] = FALSE]
    /\ UNCHANGED <<pc, alive, owner, expired, view, mine, reg, snap, committed, crashes, rounds>>

Crash(p) ==
    /\ alive[p]
    /\ pc[p] \notin {"done", "timeout"}
    /\ crashes < MaxCrashes
    /\ alive' = [alive EXCEPT ![p] = FALSE]
    /\ crashes' = crashes + 1
    /\ UNCHANGED <<pc, exists, owner, released, expired, view, mine, reg, snap, committed, rounds>>

Expire ==
    /\ AllowExpiry
    /\ Top /= None
    /\ ~expired[Top]
    /\ expired' = [expired EXCEPT ![Top] = TRUE]
    /\ UNCHANGED <<pc, alive, exists, owner, released, view, mine, reg, snap, committed, crashes, rounds>>

Step(p) ==
    /\ alive[p]
    /\ \/ List(p) \/ Judge(p) \/ GiveUp(p) \/ Create(p) \/ Recheck_(p)
       \/ CsRead(p) \/ CsWrite(p) \/ Release(p) \/ Clean(p)

Next ==
    \/ \E p \in Procs : Step(p) \/ Crash(p)
    \/ Expire

Spec == Init /\ [][Next]_vars

Symmetry == Permutations(Procs)

---------------------------------------------------------------------------------------

MutualExclusion ==
    \A p, q \in Procs :
        (p /= q /\ alive[p] /\ alive[q] /\ pc[p] \in CS /\ pc[q] \in CS) => FALSE

NoLostRegistration ==
    \A p \in Procs : (alive[p] /\ committed[p]) => p \in reg

\* The top generation is never held by a live process that will not release it.
HoldStates == CS \cup {"recheck", "release"}
NoOrphanLock ==
    (Top /= None /\ ~released[Top] /\ ~expired[Top] /\ alive[owner[Top]])
      => pc[owner[Top]] \in HoldStates
=======================================================================================
