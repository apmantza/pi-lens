------------------------- MODULE ReviewGraphSignatures -------------------------
(***************************************************************************)
(* Do the review graph's source signatures ever claim content the graph    *)
(* did not read? (clients/review-graph/builder.ts)                         *)
(*                                                                         *)
(* Every graph entry, in memory (_workspaceGraphCache) or on disk          *)
(* (review-graph.json.gz), carries three per-file maps:                    *)
(*   content[f]: the version of f the graph's nodes/edges were built from; *)
(*   sig[f]:     the `size:mtimeMs` stat the entry claims                  *)
(*               (sourceSignatureEntry);                                   *)
(*   hash[f]:    the sha256 the entry claims (contentHashEntry).           *)
(* Readers trust those claims: the sweep path serves the graph unchanged   *)
(* when every stat matches sig (_doBuildGraph), and the incremental path   *)
(* reuses a file's nodes when its current hash matches hash                *)
(* (confirmContentChanged).                                                *)
(*                                                                         *)
(* A file on disk has a content version c[f] and a stat st[f]. Edit bumps  *)
(* both; Touch bumps only the stat (formatter no-op, re-save, checkout).   *)
(* Versions never repeat, so "hash equal" is "content version equal".      *)
(*                                                                         *)
(* Build paths, per process p, one build at a time (each step is an       *)
(* await boundary where edits can land):                                   *)
(*  - sweep: stat every file (sourceSignatureMapAsync) -> base             *)
(*    is the memory entry, else the disk entry (tier 2, _doBuildGraph) ->   *)
(*    exact match serves the base; a diff goes incremental                  *)
(*    (tryIncrementalFromCache): confirm hashes, re-extract truly           *)
(*    changed files, install with the build-start stats; no base -> full    *)
(*    build (hash = the bytes read, extractFiles).                          *)
(*  - seq fast path (trySeqFastpath): candidates are the files p           *)
(*    observed changing since the entry's builtAtProjectSeq; stat them     *)
(*    (candidateStats, #3535); confirm hashes; re-extract                  *)
(*    (updateGraphFiles); install the pre-read stats as the new sig        *)
(*    (the trySeqFastpath no-op and re-extract branches). FixFpNoop /      *)
(*    FixFpExtract = FALSE model the pre-#3535 code, which RE-STATTED the  *)
(*    candidates after the read.                                           *)
(* Install replaces the memory entry and, when content changed, schedules  *)
(* a persist. Promote(p) lands p's latest scheduled persist on disk at any *)
(* later time, so cross-process late losers are included (#3509 shape).   *)
(*                                                                         *)
(* #3552: per-file extraction runs on a FactStore the graph builds for one  *)
(* run (addFileToGraph: the run-local store). Content, imports and symbols  *)
(* are read in separate awaits (ensureReviewGraphFacts), so a same-file     *)
(* dispatch that lands between them replaces the shared store's record on   *)
(* the pre-#3552 code and one node mixes two content versions. The private  *)
(* run store makes that dispatch invisible, which is the property this      *)
(* model now checks. Extract is split into the content read (ReadContent)    *)
(* and the derived read (ReadFacts), with DispatchWrite landing between     *)
(* them; SharedStore = FALSE is the merged #3552 behaviour (PR #3746), TRUE *)
(* the pre-fix shared store.                                                *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS
    Procs,
    Observers,       \* processes with a seq hint (a pi session); the others
                     \* (the MCP server, a CLI) only take the sweep path
    Writers,         \* processes whose re-extracts are persisted (the others
                     \* only read the disk snapshot: state-space bound)
    Files,
    MaxWrites,       \* total edits + touches
    AllowFastpath,
    FixFpNoop,       \* fix part 1: no-op fast path records the stat taken BEFORE the hash read
    FixFpExtract,    \* fix part 2: re-extract fast path records the stat taken BEFORE the hash read
    SharedStore      \* FALSE = #3552 run-local store (merged); TRUE = pre-fix shared store

NoEntry == [ok |-> FALSE, content |-> [f \in Files |-> 0], sig |-> [f \in Files |-> 0],
            hash |-> [f \in Files |-> 0], at |-> 0]
NoBuild == [kind |-> "none"]

VARIABLES
    c, st,          \* disk content version and stat per file
    writes,
    seq,            \* seq[p]: p's projectSeq
    lastObs,        \* lastObs[p][f]: seq at which p last observed a write to f
    mem,            \* mem[p]: memory entry
    outbox,         \* outbox[p]: latest scheduled persist (the generation gate
                    \* keeps only the current one per process)
    disk,           \* the review-graph.json.gz entry
    bld,            \* bld[p]: in-flight build
    mixed,          \* history: a build recorded a node whose content and
                    \* derived facts came from two versions
    staleServed,    \* history: a build served a graph as current while a file
                    \* it claims is stale
    regressed       \* history: a promotion put older content for some file on disk

vars == <<c, st, writes, seq, lastObs, mem, outbox, disk, bld, mixed,
          staleServed, regressed>>

Init ==
    /\ c = [f \in Files |-> 1]
    /\ st = [f \in Files |-> 1]
    /\ writes = 0
    /\ seq = [p \in Procs |-> 0]
    /\ lastObs = [p \in Procs |-> [f \in Files |-> 0]]
    /\ mem = [p \in Procs |-> NoEntry]
    /\ outbox = [p \in Procs |-> NoEntry]
    /\ disk = NoEntry
    /\ bld = [p \in Procs |-> NoBuild]
    /\ mixed = FALSE
    /\ staleServed = FALSE
    /\ regressed = FALSE

\* who = a process (a pi-observed write: it bumps that process's projectSeq)
\* or "ext" (an IDE, git, a formatter outside pi).
Write(f, who, newContent) ==
    /\ writes < MaxWrites
    /\ writes' = writes + 1
    /\ st' = [st EXCEPT ![f] = @ + 1]
    /\ c' = IF newContent THEN [c EXCEPT ![f] = @ + 1] ELSE c
    /\ IF who \in Procs
       THEN /\ seq' = [seq EXCEPT ![who] = @ + 1]
            /\ lastObs' = [lastObs EXCEPT ![who][f] = seq[who] + 1]
       ELSE UNCHANGED <<seq, lastObs>>
    /\ UNCHANGED <<mem, outbox, disk, bld, mixed, staleServed, regressed>>

\* builtAtProjectSeq: only a process with a seq hint records one.
At(p) == IF p \in Observers THEN seq[p] ELSE 0

Stale(e) == \E f \in Files : e.content[f] /= c[f]

\* The files this build extracts: a full build extracts every file; an
\* incremental or fast-path build extracts its content-changed set T.
ES(b) == IF b.kind = "full" THEN Files ELSE b.T

\* ---- sweep path (_doBuildGraph) ----
StartSweep(p) ==
    /\ bld[p] = NoBuild
    /\ LET S == st
           base == IF mem[p].ok THEN mem[p] ELSE disk
       IN IF base.ok /\ base.sig = S
          THEN \* exact match: serve the base as current (tier 1 or tier 2)
               /\ staleServed' = (staleServed \/ Stale(base))
               /\ mem' = [mem EXCEPT ![p] = [base EXCEPT !.at = At(p)]]
               /\ UNCHANGED <<bld, regressed>>
          ELSE /\ bld' = [bld EXCEPT ![p] =
                    [kind |-> IF base.ok THEN "inc" ELSE "full",
                     phase |-> "stat", base |-> base, S |-> S,
                     C |-> IF base.ok THEN {f \in Files : base.sig[f] /= S[f]} ELSE Files,
                     T |-> {}, H |-> [f \in Files |-> 0], X |-> [f \in Files |-> 0],
                     SD |-> [f \in Files |-> 0],
                     at |-> At(p)]]
               /\ UNCHANGED <<mem, staleServed, regressed>>
    /\ UNCHANGED <<c, st, writes, seq, lastObs, outbox, disk, mixed>>

\* ---- seq fast path (trySeqFastpath) ----
StartFastpath(p) ==
    /\ AllowFastpath /\ p \in Observers /\ bld[p] = NoBuild /\ mem[p].ok
    /\ LET C == {f \in Files : lastObs[p][f] > mem[p].at} IN
       /\ C /= {}
       /\ bld' = [bld EXCEPT ![p] =
             [kind |-> "fp", phase |-> "stat", base |-> mem[p],
              \* candidateStats (#3535): taken before the hash read
              S |-> st, C |-> C,
              T |-> {}, H |-> [f \in Files |-> 0], X |-> [f \in Files |-> 0],
              SD |-> [f \in Files |-> 0],
              at |-> seq[p]]]
    /\ UNCHANGED <<c, st, writes, seq, lastObs, mem, outbox, disk, mixed, staleServed, regressed>>

\* confirmContentChanged: hash the candidates now.
Confirm(p) ==
    /\ bld[p].kind \in {"inc", "fp"} /\ bld[p].phase = "stat"
    /\ LET b == bld[p] IN
       bld' = [bld EXCEPT ![p] = [b EXCEPT
                 !.H = [f \in Files |-> IF f \in b.C THEN c[f] ELSE b.base.hash[f]],
                 !.T = {f \in b.C : c[f] /= b.base.hash[f]},
                 !.phase = "confirmed"]]
    /\ UNCHANGED <<c, st, writes, seq, lastObs, mem, outbox, disk, mixed, staleServed, regressed>>

\* addFileToGraph's content read: the version each extracted file's content
\* (lineCount, exported) is recorded from. For a full build it also fixes the
\* hash map and the extracted set.
ReadContent(p) ==
    /\ \/ bld[p].kind \in {"inc", "fp"} /\ bld[p].phase = "confirmed"
       \/ bld[p].kind = "full" /\ bld[p].phase = "stat"
    /\ LET b == bld[p] IN
       bld' = [bld EXCEPT ![p] =
          IF b.kind = "full"
          THEN [b EXCEPT !.X = c, !.H = c, !.T = Files, !.phase = "content-read"]
          ELSE [b EXCEPT !.X = [f \in Files |-> IF f \in b.T THEN c[f] ELSE b.base.content[f]],
                         !.phase = "content-read"]]
    /\ UNCHANGED <<c, st, writes, seq, lastObs, mem, outbox, disk, mixed, staleServed, regressed>>

\* A same-file dispatch lands between the content read and the derived read and
\* overwrites the shared store's record for f with the content it read (c[f]).
\* On the run-local store (#3552) the write is invisible; on the pre-fix shared
\* store ReadFacts reads it back.
DispatchWrite(p) ==
    /\ bld[p] /= NoBuild /\ bld[p].phase = "content-read"
    /\ LET b == bld[p] IN
       \E f \in ES(b) : bld' = [bld EXCEPT ![p].SD[f] = c[f]]
    /\ UNCHANGED <<c, st, writes, seq, lastObs, mem, outbox, disk, mixed, staleServed, regressed>>

\* Whether a file this build is extracting has a shared-store record newer
\* than the version its content read recorded.
MixedHere(p) ==
    \E f \in ES(bld[p]) : bld[p].SD[f] > bld[p].X[f]

\* addFileToGraph's derived read (imports and symbols). On the shared store it
\* can read the dispatch's version; on the run-local store it reads the version
\* the content read recorded. A file whose two versions differ is a mixed node.
ReadFacts(p) ==
    /\ bld[p] /= NoBuild /\ bld[p].phase = "content-read"
    /\ LET b == bld[p] IN
       /\ bld' = [bld EXCEPT ![p] = [b EXCEPT !.phase = "extracted"]]
       /\ mixed' = (mixed \/ (SharedStore /\ MixedHere(p)))
    /\ UNCHANGED <<c, st, writes, seq, lastObs, mem, outbox, disk, staleServed, regressed>>

\* The signature the fast path records for a candidate.
FpSig(b) ==
    LET fixed == IF b.T = {} THEN FixFpNoop ELSE FixFpExtract IN
    [f \in Files |-> IF f \in b.C
                     THEN (IF fixed THEN b.S[f] ELSE st[f])  \* pre-#3535: re-stat now
                     ELSE b.base.sig[f]]

Install(p) ==
    /\ bld[p] /= NoBuild /\ bld[p].phase = "extracted"
    /\ LET b == bld[p]
           e == [ok |-> TRUE, content |-> b.X,
                 sig |-> IF b.kind = "fp" THEN FpSig(b) ELSE b.S,
                 hash |-> b.H, at |-> b.at]
       IN /\ mem' = [mem EXCEPT ![p] = e]
          \* #260: pure drift is not re-persisted; a re-extract is.
          /\ outbox' = IF b.T /= {} /\ p \in Writers THEN [outbox EXCEPT ![p] = e] ELSE outbox
    /\ bld' = [bld EXCEPT ![p] = NoBuild]
    /\ UNCHANGED <<c, st, writes, seq, lastObs, disk, mixed, staleServed, regressed>>

\* handleWorkerResult rename, any time later (cross-process late losers).
Promote(p) ==
    /\ outbox[p].ok
    /\ disk' = outbox[p]
    /\ regressed' = (regressed \/ (disk.ok /\ \E f \in Files : outbox[p].content[f] < disk.content[f]))
    /\ outbox' = [outbox EXCEPT ![p] = NoEntry]
    /\ UNCHANGED <<c, st, writes, seq, lastObs, mem, bld, mixed, staleServed>>

\* Idle eviction / clearReviewGraphWorkspaceCache / a restart: the next build
\* hydrates from disk. Only the observer re-hydrates; a non-observer starts
\* empty, so its first build is its disk read (state-space bound).
Evict(p) ==
    /\ p \in Observers /\ mem[p].ok /\ bld[p] = NoBuild
    /\ mem' = [mem EXCEPT ![p] = NoEntry]
    /\ UNCHANGED <<c, st, writes, seq, lastObs, outbox, disk, bld, mixed, staleServed, regressed>>

Next ==
    \/ \E f \in Files, who \in Observers \union {"ext"}, nc \in BOOLEAN : Write(f, who, nc)
    \/ \E p \in Procs :
         \/ StartSweep(p) \/ StartFastpath(p) \/ Confirm(p) \/ ReadContent(p)
         \/ DispatchWrite(p) \/ ReadFacts(p) \/ Install(p) \/ Promote(p) \/ Evict(p)

Spec == Init /\ [][Next]_vars

(***************************************************************************)
(* Invariants                                                              *)
(***************************************************************************)
\* An entry is honest when every claim it makes about the CURRENT disk is
\* backed by what it read: a matching stat or a matching hash implies the
\* graph was built from that content.
Honest(e) ==
    ~e.ok \/ \A f \in Files :
        /\ (e.sig[f] = st[f] => e.content[f] = c[f])
        /\ (e.hash[f] = c[f] => e.content[f] = c[f])

MemHonest == \A p \in Procs : Honest(mem[p])
DiskHonest == Honest(disk)

\* The user-facing promise: a validated reader (the sweep's exact match,
\* in-process or from disk) never serves a graph as current while it is stale.
NoStaleServedAsCurrent == ~staleServed

\* Every node records its content and its derived (imports/symbols) facts from
\* one content version. A run-local FactStore (#3552) makes this structural; the
\* pre-fix shared store let a concurrent dispatch split one node across two
\* versions.
NodeSingleVersion == ~mixed

\* Non-vacuity: the late-loser regression (#3509 shape) is reachable here.
DiskNoRegression == ~regressed
=============================================================================
