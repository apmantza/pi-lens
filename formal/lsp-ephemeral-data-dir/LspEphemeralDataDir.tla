--------------------------- MODULE LspEphemeralDataDir ---------------------------
(***************************************************************************)
(* The per-process data directory used by temporary LSP checkouts (#1129, *)
(* #4127). A process settles one classification for each root, then uses  *)
(* one token beneath the root's .ephemeral directory. The token is shared  *)
(* by all roots in that process, but is distinct from every other process.  *)
(* A session-start sweep may remove an old token only when its pid is not   *)
(* currently alive. Pid reuse therefore leaves the old token alone.        *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS
    ProcIds,          \* bounded process identities (not pid slots)
    Pids,             \* reusable OS pid slots
    Roots,            \* temporary checkout roots
    MaxStarts,        \* bound on process starts
    UniqueToken,      \* TRUE: process token; FALSE: pre-#4127 pid-only token
    SafeSweep         \* TRUE: sweep checks current pid liveness

Classifications == {"unknown", "ephemeral", "normal"}

VARIABLES
    live,             \* currently live process identities
    pidOf,            \* process identity -> pid slot
    tokenOf,          \* process identity -> settled data-dir token
    rootOf,           \* process identity -> first classified root
    memo,             \* process identity -> root -> classification
    usedRoots,        \* process identity -> roots already assigned a directory
    dirs,             \* records left below .ephemeral
    removed,          \* records removed by a sweep, for SweepOnlyDead
    starts            \* number of process starts

vars == <<live, pidOf, tokenOf, rootOf, memo, usedRoots, dirs, removed, starts>>

LivePids == {pidOf[p] : p \in live}

(* Before #4127 the root was absent from the shared per-process directory. *)
DirName(d) == IF UniqueToken THEN <<d.pid, d.token, d.root>>
              ELSE <<d.pid, d.token>>

Init ==
    /\ live = {}
    /\ pidOf = [p \in ProcIds |-> 0]
    /\ tokenOf = [p \in ProcIds |-> 0]
    /\ rootOf = [p \in ProcIds |-> "none"]
    /\ memo = [p \in ProcIds |-> [r \in Roots |-> "unknown"]]
    /\ usedRoots = [p \in ProcIds |-> {}]
    /\ dirs = {}
    /\ removed = {}
    /\ starts = 0

Classify(p, r, answer) ==
    /\ p \in ProcIds
    /\ r \in Roots
    /\ answer \in {"ephemeral", "normal"}
    /\ memo[p][r] = "unknown"
    /\ memo' = [memo EXCEPT ![p][r] = answer]
    /\ UNCHANGED <<live, pidOf, tokenOf, rootOf, usedRoots, dirs, removed, starts>>

Start(p, pid, r) ==
    /\ p \in ProcIds
    /\ pid \in Pids
    /\ r \in Roots
    /\ p \notin live
    /\ pidOf[p] = 0
    /\ pid \notin LivePids
    /\ memo[p][r] = "ephemeral"
    /\ starts < MaxStarts
    /\ live' = live \cup {p}
    /\ pidOf' = [pidOf EXCEPT ![p] = pid]
    /\ tokenOf' = [tokenOf EXCEPT ![p] = IF UniqueToken THEN starts + 1 ELSE pid]
    /\ rootOf' = [rootOf EXCEPT ![p] = r]
    /\ usedRoots' = [usedRoots EXCEPT ![p] = @ \cup {r}]
    /\ dirs' = dirs \cup
        {[pid |-> pid,
          token |-> IF UniqueToken THEN starts + 1 ELSE pid,
          root |-> r,
          owner |-> p]}
    /\ starts' = starts + 1
    /\ UNCHANGED <<memo, removed>>

Use(p, r) ==
    /\ p \in live
    /\ r \in Roots
    /\ r \notin usedRoots[p]
    /\ memo[p][r] = "ephemeral"
    /\ usedRoots' = [usedRoots EXCEPT ![p] = @ \cup {r}]
    /\ dirs' = dirs \cup
        {[pid |-> pidOf[p], token |-> tokenOf[p], root |-> r, owner |-> p]}
    /\ UNCHANGED <<live, pidOf, tokenOf, rootOf, memo, removed, starts>>

Stop(p) ==
    /\ p \in live
    /\ live' = live \ {p}
    /\ UNCHANGED <<pidOf, tokenOf, rootOf, memo, usedRoots, dirs, removed, starts>>

Sweep(d) ==
    /\ d \in dirs
    /\ (SafeSweep => d.pid \notin LivePids)
    /\ dirs' = dirs \ {d}
    /\ removed' = removed \cup {d}
    /\ UNCHANGED <<live, pidOf, tokenOf, rootOf, memo, usedRoots, starts>>

Skip == UNCHANGED vars

Next ==
    \/ \E p \in ProcIds, r \in Roots, answer \in {"ephemeral", "normal"} : Classify(p, r, answer)
    \/ \E p \in ProcIds, pid \in Pids, r \in Roots : Start(p, pid, r)
    \/ \E p \in ProcIds, r \in Roots : Use(p, r)
    \/ \E p \in ProcIds : Stop(p)
    \/ \E d \in dirs : Sweep(d)
    \/ Skip

TypeOK ==
    /\ live \subseteq ProcIds
    /\ pidOf \in [ProcIds -> (Pids \cup {0})]
    /\ tokenOf \in [ProcIds -> Nat]
    /\ rootOf \in [ProcIds -> (Roots \cup {"none"})]
    /\ memo \in [ProcIds -> [Roots -> Classifications]]
    /\ usedRoots \in [ProcIds -> SUBSET Roots]
    /\ starts \in Nat

NoSharedEphemeralDir ==
    \A p \in live, mine \in dirs, d \in dirs :
        mine.owner = p /\ d.owner # p => DirName(mine) # DirName(d)

NoCrossRootShare ==
    \A d1 \in dirs, d2 \in dirs :
        d1.owner = d2.owner /\ d1.root # d2.root => DirName(d1) # DirName(d2)

ClassificationConsistent ==
    \A p \in ProcIds : \A r \in usedRoots[p] : memo[p][r] = "ephemeral"

SweepOnlyDead ==
    \A d \in removed : d.owner \notin live

Spec == Init /\ [][Next]_vars

=============================================================================
