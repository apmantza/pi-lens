---------------------------- MODULE InstanceRegistryLock ----------------------------
(***************************************************************************)
(* Model of clients/instance-registry-lock.ts guarding the read-modify-    *)
(* write in clients/instance-registry.ts (writeRegistryWithRetry), #3447.   *)
(*                                                                         *)
(* The lock path names at most one inode. Each acquisition creates a new   *)
(* inode (`writeFile(lock, ..., {flag: "wx"})`: open O_EXCL, then write the *)
(* pid), so "created" and "pid written" are separate steps. Rename and     *)
(* unlink act on whatever inode the path names at that moment, which is    *)
(* the point of the model: path operations carry no identity check.        *)
(***************************************************************************)
EXTENDS Naturals, Sequences, FiniteSets, TLC

CONSTANTS
    Procs,          \* writer processes
    MaxCrashes,     \* processes that may die (SIGKILL) at any step
    AllowExpiry,    \* TRUE: a lock may outlive LOCK_STALE_MS (a live holder descheduled > 5 s)
    MaxInodes,      \* bound on acquisitions, to keep the state space finite
    Retries,        \* REGISTRY_WRITE_RETRIES
    IdentityCheck   \* candidate fix: a taker restores a lock it did not judge stale

NoInode == 0

VARIABLES
    pc,         \* per-process program counter
    alive,      \* per-process: FALSE after a crash
    lockAt,     \* inode the lock path names, or NoInode
    inodes,     \* sequence of [owner, written, expired]
    mine,       \* inode this process created on its last successful create
    judged,     \* inode this process last judged stale
    displaced,  \* inode this process's takeover rename moved away
    reg,        \* the registry file: set of registered processes
    snap,       \* registry snapshot read inside the critical section
    tries,      \* verify attempts used
    committed,  \* TRUE when the verify re-read saw this process's entry
    crashes

vars == <<pc, alive, lockAt, inodes, mine, judged, displaced, reg, snap, tries, committed, crashes>>

CS == {"cs_read", "cs_write", "cs_verify"}

Init ==
    /\ pc = [p \in Procs |-> "try"]
    /\ alive = [p \in Procs |-> TRUE]
    /\ lockAt = NoInode
    /\ inodes = << >>
    /\ mine = [p \in Procs |-> NoInode]
    /\ judged = [p \in Procs |-> NoInode]
    /\ displaced = [p \in Procs |-> NoInode]
    /\ reg = {}
    /\ snap = [p \in Procs |-> {}]
    /\ tries = [p \in Procs |-> 0]
    /\ committed = [p \in Procs |-> FALSE]
    /\ crashes = 0

\* writeFile(lock, ..., {flag: "wx"}): O_EXCL create succeeds only on an empty path.
TryCreate(p) ==
    /\ pc[p] = "try"
    /\ IF lockAt = NoInode
         THEN /\ Len(inodes) < MaxInodes
              /\ inodes' = Append(inodes, [owner |-> p, written |-> FALSE, expired |-> FALSE])
              /\ lockAt' = Len(inodes) + 1
              /\ mine' = [mine EXCEPT ![p] = Len(inodes) + 1]
              /\ pc' = [pc EXCEPT ![p] = "write"]
         ELSE /\ pc' = [pc EXCEPT ![p] = "judge"]
              /\ UNCHANGED <<inodes, lockAt, mine, displaced>>
    /\ UNCHANGED <<alive, judged, reg, snap, tries, committed, crashes, displaced>>

\* The deadline (LOCK_WAIT_MS) may pass at any retry: recordLockTimeout, op skipped.
GiveUp(p) ==
    /\ pc[p] = "try"
    /\ pc' = [pc EXCEPT ![p] = "timeout"]
    /\ UNCHANGED <<alive, lockAt, inodes, mine, judged, reg, snap, tries, committed, crashes, displaced>>

\* The pid lands in the inode this process opened, wherever the path now points.
WritePid(p) ==
    /\ pc[p] = "write"
    /\ inodes' = [inodes EXCEPT ![mine[p]].written = TRUE]
    /\ pc' = [pc EXCEPT ![p] = "cs_read"]
    /\ UNCHANGED <<alive, lockAt, mine, judged, reg, snap, tries, committed, crashes, displaced>>

\* staleLock: mtime older than LOCK_STALE_MS, or a parsed pid that is not alive.
\* An empty (unwritten) lock parses to no pid, so only age makes it stale.
IsStale(i) ==
    /\ i /= NoInode
    /\ \/ inodes[i].expired
       \/ inodes[i].written /\ ~alive[inodes[i].owner]

Judge(p) ==
    /\ pc[p] = "judge"
    /\ IF IsStale(lockAt)
         THEN /\ judged' = [judged EXCEPT ![p] = lockAt]
              /\ pc' = [pc EXCEPT ![p] = "rename"]
         ELSE /\ pc' = [pc EXCEPT ![p] = "try"]
              /\ UNCHANGED judged
    /\ UNCHANGED <<alive, lockAt, inodes, mine, reg, snap, tries, committed, crashes, displaced>>

\* takeOverStale: renameSync(lock, displaced) moves whatever the path names now.
Rename(p) ==
    /\ pc[p] = "rename"
    /\ lockAt' = NoInode
    /\ displaced' = [displaced EXCEPT ![p] = lockAt]
    /\ pc' = [pc EXCEPT ![p] = IF IdentityCheck /\ lockAt /= NoInode THEN "restore" ELSE "try"]
    /\ UNCHANGED <<alive, inodes, mine, judged, reg, snap, tries, committed, crashes>>

\* Candidate fix: read the displaced file; if it is not the lock judged stale,
\* linkSync(displaced, lock) puts it back. link fails (EEXIST) when a new lock
\* already took the path; the displaced lock is then gone for good.
Restore(p) ==
    /\ pc[p] = "restore"
    /\ IF displaced[p] /= judged[p] /\ lockAt = NoInode
         THEN lockAt' = displaced[p]
         ELSE UNCHANGED lockAt
    /\ pc' = [pc EXCEPT ![p] = "try"]
    /\ UNCHANGED <<alive, inodes, mine, judged, displaced, reg, snap, tries, committed, crashes>>

\* writeRegistryWithRetry: read, write (atomic tmp+rename), re-read to verify.
CsRead(p) ==
    /\ pc[p] = "cs_read"
    /\ snap' = [snap EXCEPT ![p] = reg]
    /\ pc' = [pc EXCEPT ![p] = "cs_write"]
    /\ UNCHANGED <<alive, lockAt, inodes, mine, judged, reg, tries, committed, crashes, displaced>>

CsWrite(p) ==
    /\ pc[p] = "cs_write"
    /\ reg' = snap[p] \cup {p}
    /\ pc' = [pc EXCEPT ![p] = "cs_verify"]
    /\ UNCHANGED <<alive, lockAt, inodes, mine, judged, snap, tries, committed, crashes, displaced>>

CsVerify(p) ==
    /\ pc[p] = "cs_verify"
    /\ tries' = [tries EXCEPT ![p] = @ + 1]
    /\ IF p \in reg
         THEN /\ committed' = [committed EXCEPT ![p] = TRUE]
              /\ pc' = [pc EXCEPT ![p] = "rel_check"]
         ELSE /\ pc' = [pc EXCEPT ![p] = IF tries[p] + 1 < Retries THEN "cs_read" ELSE "rel_check"]
              /\ UNCHANGED committed
    /\ UNCHANGED <<alive, lockAt, inodes, mine, judged, reg, snap, crashes, displaced>>

\* releaseLock: ownsLock reads the pid at the path, then unlink acts on the path.
RelCheck(p) ==
    /\ pc[p] = "rel_check"
    /\ pc' = [pc EXCEPT ![p] =
                IF lockAt /= NoInode /\ inodes[lockAt].written /\ inodes[lockAt].owner = p
                  THEN "rel_unlink" ELSE "done"]
    /\ UNCHANGED <<alive, lockAt, inodes, mine, judged, reg, snap, tries, committed, crashes, displaced>>

RelUnlink(p) ==
    /\ pc[p] = "rel_unlink"
    /\ lockAt' = NoInode
    /\ pc' = [pc EXCEPT ![p] = "done"]
    /\ UNCHANGED <<alive, inodes, mine, judged, reg, snap, tries, committed, crashes, displaced>>

Crash(p) ==
    /\ alive[p]
    /\ pc[p] \notin {"done", "timeout"}
    /\ crashes < MaxCrashes
    /\ alive' = [alive EXCEPT ![p] = FALSE]
    /\ crashes' = crashes + 1
    /\ UNCHANGED <<pc, lockAt, inodes, mine, judged, reg, snap, tries, committed, displaced>>

\* The lock the path names outlives LOCK_STALE_MS while its holder still runs.
Expire ==
    /\ AllowExpiry
    /\ lockAt /= NoInode
    /\ ~inodes[lockAt].expired
    /\ inodes' = [inodes EXCEPT ![lockAt].expired = TRUE]
    /\ UNCHANGED <<pc, alive, lockAt, mine, judged, reg, snap, tries, committed, crashes, displaced>>

Step(p) ==
    /\ alive[p]
    /\ \/ TryCreate(p) \/ GiveUp(p) \/ WritePid(p) \/ Judge(p) \/ Rename(p) \/ Restore(p)
       \/ CsRead(p) \/ CsWrite(p) \/ CsVerify(p) \/ RelCheck(p) \/ RelUnlink(p)

Next ==
    \/ \E p \in Procs : Step(p) \/ Crash(p)
    \/ Expire

Spec == Init /\ [][Next]_vars

Symmetry == Permutations(Procs)

---------------------------------------------------------------------------------------
\* Safety properties.

TypeOK ==
    /\ lockAt \in 0..MaxInodes
    /\ crashes \in 0..MaxCrashes

\* At most one live process inside the read-modify-write.
MutualExclusion ==
    \A p, q \in Procs :
        (p /= q /\ alive[p] /\ alive[q] /\ pc[p] \in CS /\ pc[q] \in CS) => FALSE

\* A lock that no live step will release and that no one may take over:
\* its owner is alive, past its critical section, and it has not expired.
HoldStates == CS \cup {"write", "rel_check", "rel_unlink"}
NoOrphanLock ==
    (lockAt /= NoInode /\ inodes[lockAt].written /\ ~inodes[lockAt].expired
        /\ alive[inodes[lockAt].owner])
      => pc[inodes[lockAt].owner] \in HoldStates

\* A registration whose verify re-read succeeded is still in the registry.
NoLostRegistration ==
    \A p \in Procs : (alive[p] /\ committed[p]) => p \in reg
=======================================================================================
