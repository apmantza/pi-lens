---------------------------- MODULE SiblingRestore ----------------------------
(***************************************************************************)
(* One SIBLING file S of a whole-package fixer (`cargo clippy --fix`,      *)
(* `dart fix --apply`), and the restore that puts the agent's edits of S   *)
(* back over the tool's write (clients/fix-run-restore.ts, #3598, #3741,   *)
(* #3830). The pipeline's hold on pi's mutation queue covers only the      *)
(* edit's own target F, so the tool reads and writes S outside the queue.  *)
(*                                                                         *)
(* Lock order (#3830). Two queue entries are modelled: S's (`sq`) and the  *)
(* target F's (`fq`). With TargetHold the pipeline takes F's entry at      *)
(* Begin and keeps it until its work is done (RelF), as `runPipeline` does *)
(* (#3506). An LSP multi-path edit (LspMulti, `applyWorkspaceEdit` ->      *)
(* `withHostFileMutationQueues`) takes S, then F: its keys are sorted, and *)
(* S sorts first. It writes nothing here: it is a lock-order actor only    *)
(* (what an LSP edit writes is LspEditQueue's question). A restore that    *)
(* takes S's entry (RestoreQueue) while the pipeline holds F and waits for *)
(* the restore to end (RestoreGatesHold = TRUE) closes a cycle with that   *)
(* edit, and TLC's deadlock check finds it (SiblingRestoreQueuedInHold).   *)
(* The code does not wait: `runWithFixRestore` starts `restore` once the   *)
(* caller has scanned the tool's changes and returns it as a promise,      *)
(* awaited only after the pipeline has released F (RestoreGatesHold =      *)
(* FALSE), so F's release never depends on the restore and the restore     *)
(* holds nothing while it waits for S's entry.                             *)
(*                                                                         *)
(* Actors:                                                                 *)
(*  - the agent: edits 1..SEdits of S, in order, each a read-modify-write  *)
(*    under pi's per-file queue for S. pi-lens sees an edit twice:         *)
(*    SACall (tool_call: noteAgentCallStart, "in flight") and SANote       *)
(*    (tool_result: noteAgentCallEnd, then noteAgentMutation, which reads  *)
(*    S and keeps the bytes as the capture). runtime-tool-result.ts has    *)
(*    no await between the two on the native edit/write path; the awaits   *)
(*    between them are the bash branch.                                    *)
(*  - the tool: Begin (beginFixRun: hash the set, register the run), TRead *)
(*    and TWrite (reads S, later writes its fix of what it read, outside   *)
(*    the queue), Finish (the tool exited; `finish()` returns the          *)
(*    agentEdited list and the `restore` thunk).                           *)
(*  - the restore: RLock (S's queue entry, RestoreQueue), RRead (readFile  *)
(*    and the decision table of the module header), RRecheck (the content  *)
(*    re-read before the write; the model's version counter is a perfect   *)
(*    identity), RWrite (writeFileAtomicAsync of the capture). Without     *)
(*    RestoreQueue, compare and write are separate steps with S's queue    *)
(*    not held: the code before #3830.                                     *)
(*                                                                         *)
(* A content is the set of agent edits it holds plus a "fixed" bit, so a   *)
(* stale write by the tool shows as a missing edit. Identity is a version  *)
(* counter bumped by every write: a perfect identity. The code compares    *)
(* bytes before the write (the stat identity it replaced, mtime + size +   *)
(* inode, was blind to a same-size edit inside one mtime tick); the model  *)
(* does not see that difference. The report is one set for the file.       *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS
    SEdits,         \* agent edits of S; 0 leaves the sibling out
    SConcurrent,    \* TRUE: an agent edit of S can run while the fixer run is open (pi's parallel tools, or a handler its 10 s bound abandoned: the run's own timeout is 30 s)
    SAtomic,        \* TRUE: an agent edit of S is never between its tool_call and its tool_result while a tool or restore step runs (the result reaches pi-lens at once); FALSE: it can be
    SCallInRun,     \* TRUE: the tool_call of every agent edit of S reaches pi-lens while the run is open (none is called before beginFixRun)
    SRestore,       \* FALSE: the code before #3598 (no capture, no restore)
    SettleCapture,  \* candidate fix: the run stays registered (captures and in-flight calls tracked) until its restore has settled
    RestoreNoCapInFlight, \* candidate fix for finding B: a file with no capture and a call in flight is named possibly lost
    RestoreInFlight,\* TRUE: settle leaves a file with a call in flight alone (#3741 round 2)
    RestoreRecheck, \* TRUE: the re-stat before the write (#3741 round 2)
    RestoreQueue,   \* the restore's read, decision, re-check and write run inside pi's queue entry for S (a per-sibling entry taken only for the restore, #3830)
    TargetHold,     \* TRUE: the pipeline holds the target F's queue entry from Begin until its work is done (#3506)
    RestoreGatesHold, \* TRUE (the rejected shape): the pipeline releases F's entry only after the restore has ended. FALSE (the code, #3830): the restore starts once the caller has scanned the tool's changes and F's release does not wait for it
    LspMulti        \* TRUE: an LSP multi-path edit takes S's entry, then F's (keys sorted, S first), and waits for F while it holds S

SIds == 1..SEdits
C0 == [e |-> {}, f |-> FALSE]
NoCap == [has |-> FALSE, b |-> C0, v |-> "verified"]

VARIABLES
    sdisk, sver, sq, sapplied, sa, sabuf,
    infl, cap, tpc, tbuf,
    rpc, rbuf, rv, rcap, rc, rep, wk,
    fq, lpc

vars == <<sdisk, sver, sq, sapplied, sa, sabuf, infl, cap, tpc, tbuf,
          rpc, rbuf, rv, rcap, rc, rep, wk, fq, lpc>>

Init ==
    /\ sdisk = C0 /\ sver = 0 /\ sq = "none" /\ sapplied = {}
    /\ sa = [i \in SIds |-> "idle"] /\ sabuf = C0
    /\ infl = {} /\ cap = NoCap /\ tpc = "none" /\ tbuf = C0
    /\ rpc = "idle" /\ rbuf = C0 /\ rv = 0 /\ rcap = NoCap /\ rc = 0
    /\ rep = {} /\ wk = {}
    /\ fq = "none" /\ lpc = "idle"

\* SAtomic: no agent edit is mid-call. Gates every tool and restore step.
Quiet == SAtomic => \A i \in SIds : sa[i] \in {"idle", "done"}

\* The run is in `active` (noteAgentMutation and noteAgentCallStart reach it):
\* from beginFixRun to the start of finish(), or, under SettleCapture, to the
\* end of the restore.
Registered ==
    /\ SRestore
    /\ IF SettleCapture
         THEN rpc \in {"run", "rread", "rlock", "rrecheck", "rwrite"}
         ELSE rpc = "run"

\* The in-flight set the restore honours. settle copies `run.calls.values()` at
\* its start; once finish() has left `active`, nothing changes the set
\* (noteAgentCallStart and noteAgentCallEnd reach only active runs), so the
\* copy and the live set coincide. Under SettleCapture the run stays active.
InFl == infl

----------------------------------------------------------------------------
\* tool_call: pi-lens notes the call in flight (only while the run is active).
SACall(i) ==
    /\ sa[i] = "idle"
    /\ IF i = 1 THEN TRUE ELSE sa[i - 1] # "idle"
    /\ SConcurrent \/ rpc \in {"idle", "done"}
    /\ SCallInRun => rpc \in {"run", "rread", "rlock", "rrecheck", "rwrite"}
    /\ sa' = [sa EXCEPT ![i] = "called"]
    /\ infl' = IF Registered THEN infl \cup {i} ELSE infl
    /\ UNCHANGED <<sdisk, sver, sq, sapplied, sabuf, cap, tpc, tbuf,
                   rpc, rbuf, rv, rcap, rc, rep, wk, fq, lpc>>

\* pi's edit: read S inside S's queue ...
SARead(i) ==
    /\ sa[i] = "called" /\ sq = "none"
    /\ IF i = 1 THEN TRUE ELSE sa[i - 1] \in {"written", "done"}
    /\ sabuf' = sdisk /\ sq' = "agent"
    /\ sa' = [sa EXCEPT ![i] = "read"]
    /\ UNCHANGED <<sdisk, sver, sapplied, infl, cap, tpc, tbuf,
                   rpc, rbuf, rv, rcap, rc, rep, wk, fq, lpc>>

\* ... and write it back with edit i applied.
SAWrite(i) ==
    /\ sa[i] = "read"
    /\ sdisk' = [e |-> sabuf.e \cup {i}, f |-> sabuf.f]
    /\ sver' = sver + 1
    /\ sapplied' = sapplied \cup {i}
    /\ sq' = "none"
    /\ sa' = [sa EXCEPT ![i] = "written"]
    /\ UNCHANGED <<sabuf, infl, cap, tpc, tbuf,
                   rpc, rbuf, rv, rcap, rc, rep, wk, fq, lpc>>

\* tool_result: noteAgentCallEnd, then noteAgentMutation reads S now. The
\* verdict checks the agent's own stated write (verdictFor): edit i's text is
\* in the bytes, or the tool's write already erased it.
SANote(i) ==
    /\ sa[i] = "written"
    /\ infl' = IF Registered THEN infl \ {i} ELSE infl
    /\ cap' = IF Registered
                THEN [has |-> TRUE, b |-> sdisk,
                      v |-> IF i \in sdisk.e THEN "verified" ELSE "overwritten"]
                ELSE cap
    /\ sa' = [sa EXCEPT ![i] = "done"]
    /\ UNCHANGED <<sdisk, sver, sq, sapplied, sabuf, tpc, tbuf,
                   rpc, rbuf, rv, rcap, rc, rep, wk, fq, lpc>>

----------------------------------------------------------------------------
\* beginFixRun: hash the files, register the run. Under pi's sequential tool
\* execution no agent edit of S is mid-call here: the run is inside the
\* handler pi awaits. With TargetHold the pipeline has taken F's entry first
\* (`writeHold.acquire()` precedes `snapshotProjectFiles`), so Begin waits for it.
Begin ==
    /\ SEdits > 0 /\ rpc = "idle"
    /\ Quiet
    /\ ~SConcurrent => \A i \in SIds : sa[i] \in {"idle", "done"}
    /\ TargetHold => fq = "none"
    /\ fq' = IF TargetHold THEN "pipe" ELSE fq
    /\ rpc' = "run"
    /\ UNCHANGED <<sdisk, sver, sq, sapplied, sa, sabuf, infl, cap, tpc,
                   tbuf, rbuf, rv, rcap, rc, rep, wk, lpc>>

\* The tool reads S, later writes its fix of what it read, outside the queue.
TRead ==
    /\ rpc = "run" /\ tpc = "none"
    /\ Quiet
    /\ tbuf' = sdisk /\ tpc' = "read"
    /\ UNCHANGED <<sdisk, sver, sq, sapplied, sa, sabuf, infl, cap,
                   rpc, rbuf, rv, rcap, rc, rep, wk, fq, lpc>>

TWrite ==
    /\ rpc = "run" /\ tpc = "read"
    /\ Quiet
    /\ sdisk' = [e |-> tbuf.e, f |-> TRUE]
    /\ sver' = sver + 1
    /\ tpc' = "wrote"
    /\ UNCHANGED <<sq, sapplied, sa, sabuf, infl, cap, tbuf,
                   rpc, rbuf, rv, rcap, rc, rep, wk, fq, lpc>>

\* The tool exited: `finish()` returns the agentEdited list and the `restore`
\* thunk, which `runWithFixRestore` starts once the caller has scanned the
\* tool's changes (the scan touches neither S nor a queue entry, so the model
\* folds it into Finish). Without SettleCapture the run left `active` here (the
\* code before #3830).
Finish ==
    /\ rpc = "run" /\ tpc # "read"
    /\ Quiet
    /\ rpc' = IF ~SRestore THEN "done"
              ELSE IF RestoreQueue THEN "rlock"
              ELSE "rread"
    /\ UNCHANGED <<sdisk, sver, sq, sapplied, sa, sabuf, infl, cap, tpc, tbuf,
                   rbuf, rv, rcap, rc, rep, wk, fq, lpc>>

\* The pipeline's work on F is over and `runPipeline` releases F's entry. The
\* pipeline's other work after the tool's exit (its reads of F) touches neither
\* S nor a queue entry and is not modelled, so this can happen any time after
\* Finish; with RestoreGatesHold it waits for the restore.
RelF ==
    /\ TargetHold /\ fq = "pipe"
    /\ rpc \notin {"idle", "run"}
    /\ RestoreGatesHold => rpc = "done"
    /\ fq' = "none"
    /\ UNCHANGED <<sdisk, sver, sq, sapplied, sa, sabuf, infl, cap, tpc, tbuf,
                   rpc, rbuf, rv, rcap, rc, rep, wk, lpc>>

\* RestoreQueue: enter pi's queue for S (waits for an edit or an LSP edit that
\* holds it). It holds no other entry; F's may still be held by the pipeline,
\* which does not wait for the restore (unless RestoreGatesHold).
RLock ==
    /\ rpc = "rlock" /\ sq = "none"
    /\ Quiet
    /\ sq' = "restore" /\ rpc' = "rread"
    /\ UNCHANGED <<sdisk, sver, sapplied, sa, sabuf, infl, cap, tpc, tbuf,
                   rbuf, rv, rcap, rc, rep, wk, fq, lpc>>

\* readFile of S, then the decision table of fix-run-restore.ts. With
\* RestoreQueue it runs inside S's entry and a skip leaves the entry.
RRead ==
    /\ rpc = "rread"
    /\ Quiet
    /\ rbuf' = sdisk /\ rv' = sver /\ rcap' = cap
    /\ LET next ==
             IF ~cap.has THEN "done"
             ELSE IF cap.v = "overwritten" THEN "done"
             ELSE IF RestoreInFlight /\ InFl # {} THEN "done"
             ELSE IF sdisk = cap.b THEN "done"
             ELSE "rrecheck"
           named ==
             IF ~cap.has /\ RestoreNoCapInFlight /\ InFl # {} THEN {"possibly"}
             ELSE IF cap.has /\ cap.v = "overwritten" THEN {"lost"}
             ELSE IF cap.has /\ RestoreInFlight /\ InFl # {} /\ sdisk # cap.b THEN {"possibly"}
             ELSE {}
       IN /\ rpc' = next
          /\ rep' = rep \cup named
          /\ sq' = IF RestoreQueue /\ next = "done" THEN "none" ELSE sq
    /\ UNCHANGED <<sdisk, sver, sapplied, sa, sabuf, infl, cap, tpc,
                   tbuf, rc, wk, fq, lpc>>

\* The re-check before the write: unchanged since the read, else the file moved
\* again and is not ours to overwrite. Without RestoreRecheck (#3741 round 1)
\* the write goes on.
RRecheck ==
    /\ rpc = "rrecheck"
    /\ Quiet
    /\ rc' = sver
    /\ IF ~RestoreRecheck \/ sver = rv
         THEN /\ rpc' = "rwrite" /\ UNCHANGED <<rep, sq>>
         ELSE /\ rpc' = "done" /\ rep' = rep \cup {"possibly"}
              /\ sq' = IF RestoreQueue THEN "none" ELSE sq
    /\ UNCHANGED <<sdisk, sver, sapplied, sa, sabuf, infl, cap, tpc, tbuf,
                   rbuf, rv, rcap, wk, fq, lpc>>

\* writeFileAtomicAsync of the capture. `wk` records, from the variables the
\* steps kept, whether the bytes replaced held an agent edit newer than the
\* capture, and which window it landed in.
RWrite ==
    /\ rpc = "rwrite"
    /\ Quiet
    /\ sdisk' = rcap.b
    /\ sver' = sver + 1
    /\ rep' = rep \cup {"restored"}
    /\ wk' = (IF rbuf.e \ rcap.b.e # {} THEN {"read"} ELSE {})
             \cup (IF rc # rv THEN {"pre"} ELSE {})
             \cup (IF sver # rc THEN {"gap"} ELSE {})
             \cup (IF rbuf = rcap.b THEN {"noop"} ELSE {})
    /\ sq' = IF RestoreQueue THEN "none" ELSE sq
    /\ rpc' = "done"
    /\ UNCHANGED <<sapplied, sa, sabuf, infl, cap, tpc, tbuf,
                   rbuf, rv, rcap, rc, fq, lpc>>

\* The LSP multi-path edit: S's entry, then F's, in key order (S sorts first).
\* It holds S while it waits for F.
LGetS ==
    /\ LspMulti /\ lpc = "idle" /\ sq = "none"
    /\ sq' = "lsp" /\ lpc' = "holdS"
    /\ UNCHANGED <<sdisk, sver, sapplied, sa, sabuf, infl, cap, tpc, tbuf,
                   rpc, rbuf, rv, rcap, rc, rep, wk, fq>>

LGetF ==
    /\ lpc = "holdS" /\ fq = "none"
    /\ fq' = "lsp" /\ lpc' = "holdBoth"
    /\ UNCHANGED <<sdisk, sver, sq, sapplied, sa, sabuf, infl, cap, tpc, tbuf,
                   rpc, rbuf, rv, rcap, rc, rep, wk>>

LDone ==
    /\ lpc = "holdBoth"
    /\ sq' = "none" /\ fq' = "none" /\ lpc' = "done"
    /\ UNCHANGED <<sdisk, sver, sapplied, sa, sabuf, infl, cap, tpc, tbuf,
                   rpc, rbuf, rv, rcap, rc, rep, wk>>

\* Everything that will happen has happened: TLC's deadlock check (CHECK_DEADLOCK
\* TRUE) must not flag this state, and flags every other state with no step. An
\* edit still idle is not stuck: with SCallInRun its tool_call can no longer
\* come, and without it SACall is enabled, so the state has a step anyway.
Finished ==
    /\ rpc = "done" /\ \A i \in SIds : sa[i] \in {"idle", "done"}
    /\ fq # "pipe" /\ lpc \in {"idle", "done"}
    /\ UNCHANGED vars

Next ==
    \/ Begin \/ TRead \/ TWrite \/ Finish \/ RelF
    \/ RRead \/ RLock \/ RRecheck \/ RWrite
    \/ LGetS \/ LGetF \/ LDone
    \/ \E i \in SIds : SACall(i) \/ SARead(i) \/ SAWrite(i) \/ SANote(i)
    \/ Finished

Spec == Init /\ [][Next]_vars

----------------------------------------------------------------------------
SQuiescent == rpc = "done" /\ \A i \in SIds : sa[i] = "done"

\* Every agent edit of S is on disk at the end, or the report names the file
\* as lost or possibly lost, so the agent can re-apply it (NoLostEdit's
\* analogue: here the eraser is the tool, and the capture, the restore and the
\* report are the defence).
NoSilentLoss ==
    SQuiescent => \/ \A i \in sapplied : i \in sdisk.e
                  \/ rep \cap {"lost", "possibly"} # {}

\* Stronger: every agent edit of S is on disk at the end (no loss at all).
EveryEditSurvives == SQuiescent => \A i \in sapplied : i \in sdisk.e

\* The restore never writes over content newer than its capture (the module
\* header's "restore invariant"). Its three windows: an edit already on disk
\* at the restore's read but not in the capture; one that landed between the
\* read and the re-stat; one that landed after the re-stat.
NoRestoreOverNewer == wk \ {"noop"} = {}
NoRestoreOverReadEdit == "read" \notin wk
NoRestoreOverPreCheckEdit == "pre" \notin wk
NoRestoreOverGapEdit == "gap" \notin wk

\* The restore writes nothing when S already holds the capture's bytes
\* (fix-run-restore.ts `if (unchanged) continue`). Without that skip it rewrites
\* identical bytes, reports `restored` for a file the tool never erased, and
\* opens the gap window for nothing.
NoNoopRestore == "noop" \notin wk
=============================================================================
