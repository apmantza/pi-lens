-------------------------- MODULE DispatchPipeline --------------------------
(***************************************************************************)
(* One file F on the post-write dispatch path: the agent's edits, the      *)
(* tool_result handler and pipeline run each edit starts, the per-file     *)
(* stores those runs write, and pi-lens' own in-place autofix writer.      *)
(*                                                                         *)
(* Actors:                                                                 *)
(*  - the agent: edits 1..Edits of F, in order. Each edit is a read-modify *)
(*    -write under pi's per-file mutation queue (pi-coding-agent           *)
(*    core/tools/edit.js withFileMutationQueue). With Parallel (pi's       *)
(*    default toolExecution) edit i+1 may run while edit i's tool_result   *)
(*    handler is still running (agent-loop.js executeToolCallsParallel);   *)
(*    otherwise pi awaits the handler (afterToolCall) before the next      *)
(*    tool, unless the handler was abandoned by its 10 s bound (Orphan:    *)
(*    index.ts ~2733 `bounded(handleToolResult(...))`, deadline-utils.ts   *)
(*    `bounded`: "The promise is not cancelled").                          *)
(*  - handler/pipeline i (runtime-tool-result.ts handleToolResult,         *)
(*    dispatchPipelineAnalysis; pipeline.ts runPipeline):                  *)
(*      Hash:    postWriteStateHash = sha(disk) (~2072), claim             *)
(*               (claimPipelineDispatch ~436: in-flight dedupe on          *)
(*               (file, hash), then the already-analysed latch),           *)
(*               writeIndex = nextWriteIndex() (~2185);                    *)
(*      Gap:     (ClaimGap) `await bounded(classifiedClients)` (~2324),    *)
(*               reached only when bootstrap clients are not resident;     *)
(*      Start:   registerInFlightPipeline (~918), runPipeline's            *)
(*               admitWidgetDiagnosticsWrite (pipeline.ts ~1435) and       *)
(*               readFileSync (~1449) -- all synchronous with the claim    *)
(*               unless ClaimGap;                                          *)
(*      FixRead/FixWrite: the in-place fixer (biome `lint --write`,        *)
(*               eslint --fix, ...; pipeline.ts runAutofix ~726) reads     *)
(*               the file, then writes its fix of what it read;            *)
(*      Refresh: before/after compare (biome-client.ts ~409), content      *)
(*               refresh and postWriteStateHash (pipeline.ts ~1560-1600);  *)
(*      Analyse: dispatchLintWithResult returns; recordDiagnostics into    *)
(*               the widget store under its WriteOrderingGuard             *)
(*               (widget-state.ts ~315, ~858);                             *)
(*      Release: releaseInFlightPipeline (~995, deletes by hash key) and   *)
(*               the already-analysed latch (~1054);                       *)
(*      Record:  handler records/clears the turn-end inline-blocker        *)
(*               record (~2540 recordInlineBlockers / ~2553                *)
(*               clearInlineBlockers; runtime-coordinator.ts ~1097), which *)
(*               the git-guard latch aggregates (~530).                    *)
(*                                                                         *)
(* Content is the set of agent edits it contains plus a "fixed" bit, so a  *)
(* fixer write of stale bytes shows as a missing edit. Blocker verdicts    *)
(* are a function of the newest edit a content contains, chosen at Init.   *)
(* Every await is a step boundary.                                         *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS
    Edits,          \* number of agent edits of F (one pipeline each)
    Parallel,       \* TRUE: the next edit need not wait for the previous handler
    Orphan,         \* TRUE: a handler may be abandoned by its bound; its pipeline runs on
    ImmediateEdits, \* edits whose pipeline runs the immediate autofix (a turn's first `write`)
    ClaimGap,       \* TRUE: an await sits between the claim and the registration
    InFlightDedupe, \* FALSE: mutant without the in-flight (file, hash) dedupe
    WidgetGuard,    \* FALSE: mutant without the widget WriteOrderingGuard
    FixRecord,      \* candidate fix: a record is applied only when not older than the last applied write
    FixClear,       \* candidate fix: a clear is applied only when not older than the last applied write
    FixTomb,        \* candidate fix: the last applied token survives a clear (a per-path guard, not the record's own field)
    FixQueue,       \* candidate fix, part 1: the fixer's read-fix-write runs inside pi's withFileMutationQueue for F
    FixQueueRefresh,\* candidate fix, part 2: the queue is held through the after-read, refresh and postWriteStateHash
    FixReToken,     \* candidate fix, part 3: a post-autofix content refresh takes a fresh writeIndex (token = when the analysed bytes were read)
    WriterBound,    \* TRUE: the pipeline's own bound on the writer (FormatService's per-file budget) can give up on it while its child runs on
    FixHoldWriter   \* review-round-1 fix: the hold is released only once an abandoned writer has settled

Pipes == 1..Edits
NoC == [e |-> {0}, f |-> FALSE]          \* "no hash yet"
Init0 == [e |-> {}, f |-> FALSE]
Max(a, b) == IF a > b THEN a ELSE b
MaxE(S) == IF S = {} THEN 0 ELSE CHOOSE x \in S : \A y \in S : y <= x

VARIABLES
    disk, applied, blk,
    agentI, agentPc, abuf, qlock,
    hpc, hsh, wi, ct, fbuf, fixedBy, fh, aband, jt,
    nextWi, regMap, latch,
    widget, wSeen,
    inl, itok,
    orphanW

vars == <<disk, applied, blk, agentI, agentPc, abuf, qlock, hpc, hsh, wi, ct,
          fbuf, fixedBy, fh, aband, jt, nextWi, regMap, latch, widget, wSeen,
          inl, itok, orphanW>>

Blocker(c) == MaxE(c.e) \in blk

Init ==
    /\ disk = Init0 /\ applied = {} /\ blk \in SUBSET Pipes
    /\ agentI = 1 /\ agentPc = "read" /\ abuf = Init0 /\ qlock = "none"
    /\ hpc = [i \in Pipes |-> "idle"]
    /\ hsh = [i \in Pipes |-> NoC] /\ wi = [i \in Pipes |-> 0]
    /\ ct = [i \in Pipes |-> NoC] /\ fbuf = [i \in Pipes |-> NoC]
    /\ fixedBy = [i \in Pipes |-> FALSE] /\ fh = [i \in Pipes |-> NoC]
    /\ aband = [i \in Pipes |-> FALSE] /\ jt = [i \in Pipes |-> 0]
    /\ nextWi = 1 /\ regMap = {} /\ latch = NoC
    /\ widget = Init0 /\ wSeen = 0
    /\ inl = [has |-> FALSE, c |-> Init0, tok |-> 0] /\ itok = 0
    /\ orphanW = [i \in Pipes |-> FALSE]

HandlerReturned(i) == hpc[i] = "done" \/ aband[i]

----------------------------------------------------------------------------
\* The agent: edit i reads F and writes it back with edit i applied, holding
\* pi's per-file mutation queue across the read-modify-write.
AgentRead ==
    /\ agentPc = "read" /\ qlock = "none"
    /\ (~Parallel /\ agentI > 1) => HandlerReturned(agentI - 1)
    /\ abuf' = disk /\ qlock' = "agent" /\ agentPc' = "write"
    /\ UNCHANGED <<disk, applied, blk, agentI, hpc, hsh, wi, ct, fbuf, fixedBy, fh,
                   aband, jt, nextWi, regMap, latch, widget, wSeen, inl, itok>>
    /\ UNCHANGED orphanW

AgentWrite ==
    /\ agentPc = "write"
    /\ disk' = [e |-> abuf.e \cup {agentI}, f |-> abuf.f]
    /\ applied' = applied \cup {agentI}
    /\ qlock' = "none"
    /\ hpc' = [hpc EXCEPT ![agentI] = "hash"]
    /\ agentI' = agentI + 1
    /\ agentPc' = IF agentI = Edits THEN "done" ELSE "read"
    /\ UNCHANGED <<blk, abuf, hsh, wi, ct, fbuf, fixedBy, fh, aband, jt, nextWi,
                   regMap, latch, widget, wSeen, inl, itok>>
    /\ UNCHANGED orphanW

----------------------------------------------------------------------------
\* registerInFlightPipeline: filePipelines.set(stateHash, pipeline) -- a
\* second registration under one hash replaces the first.
Register(i, h) == regMap' = {x \in regMap : x[1] # h} \cup {<<h, i>>}
AfterStart(i) == IF i \in ImmediateEdits THEN "fixread" ELSE "analyse"

\* postWriteStateHash, claimPipelineDispatch, nextWriteIndex; without
\* ClaimGap also registration, widget admission and the content read.
Hash(i) ==
    /\ hpc[i] = "hash"
    /\ LET h == disk
           dup == InFlightDedupe /\ \E x \in regMap : x[1] = h
       IN IF dup
          THEN /\ hpc' = [hpc EXCEPT ![i] = "join"]
               /\ jt' = [jt EXCEPT ![i] = (CHOOSE x \in regMap : x[1] = h)[2]]
               /\ UNCHANGED <<hsh, wi, nextWi, regMap, wSeen, ct>>
          ELSE IF latch = h
          THEN /\ hpc' = [hpc EXCEPT ![i] = "done"]
               /\ UNCHANGED <<hsh, wi, nextWi, regMap, wSeen, ct, jt>>
          ELSE /\ hsh' = [hsh EXCEPT ![i] = h]
               /\ wi' = [wi EXCEPT ![i] = nextWi]
               /\ nextWi' = nextWi + 1
               /\ UNCHANGED jt
               /\ IF ClaimGap
                    THEN /\ hpc' = [hpc EXCEPT ![i] = "gap"]
                         /\ UNCHANGED <<regMap, wSeen, ct>>
                    ELSE /\ Register(i, h)
                         /\ wSeen' = Max(wSeen, nextWi)
                         /\ ct' = [ct EXCEPT ![i] = disk]
                         /\ hpc' = [hpc EXCEPT ![i] = AfterStart(i)]
    /\ UNCHANGED <<disk, applied, blk, agentI, agentPc, abuf, qlock, fbuf, fixedBy,
                   fh, aband, latch, widget, inl, itok>>
    /\ UNCHANGED orphanW

\* After the clients await: register, admit, read.
Start(i) ==
    /\ hpc[i] = "gap"
    /\ Register(i, hsh[i])
    /\ wSeen' = Max(wSeen, wi[i])
    /\ ct' = [ct EXCEPT ![i] = disk]
    /\ hpc' = [hpc EXCEPT ![i] = AfterStart(i)]
    /\ UNCHANGED <<disk, applied, blk, agentI, agentPc, abuf, qlock, hsh, wi, fbuf,
                   fixedBy, fh, aband, jt, nextWi, latch, widget, inl, itok>>
    /\ UNCHANGED orphanW

\* The in-place fixer reads F (inside the queue under FixQueue).
FixRead(i) ==
    /\ hpc[i] = "fixread"
    /\ FixQueue => qlock = "none"
    /\ qlock' = IF FixQueue THEN "fix" ELSE qlock
    /\ fbuf' = [fbuf EXCEPT ![i] = disk]
    /\ hpc' = [hpc EXCEPT ![i] = "fixwrite"]
    /\ UNCHANGED <<disk, applied, blk, agentI, agentPc, abuf, hsh, wi, ct, fixedBy,
                   fh, aband, jt, nextWi, regMap, latch, widget, wSeen, inl, itok>>
    /\ UNCHANGED orphanW

\* ... and writes its fix of what it read.
FixWrite(i) ==
    /\ hpc[i] = "fixwrite"
    /\ disk' = [e |-> fbuf[i].e, f |-> TRUE]
    /\ qlock' = IF FixQueue /\ ~FixQueueRefresh THEN "none" ELSE qlock
    /\ hpc' = [hpc EXCEPT ![i] = "refresh"]
    /\ UNCHANGED <<applied, blk, agentI, agentPc, abuf, hsh, wi, ct, fbuf, fixedBy,
                   fh, aband, jt, nextWi, regMap, latch, widget, wSeen, inl, itok>>
    /\ UNCHANGED orphanW

\* After-read compare, content refresh and postWriteStateHash.
Refresh(i) ==
    /\ hpc[i] = "refresh"
    /\ LET moved == disk # fbuf[i]
       IN /\ fixedBy' = [fixedBy EXCEPT ![i] = moved]
          /\ ct' = [ct EXCEPT ![i] = IF moved THEN disk ELSE ct[i]]
          /\ IF FixReToken /\ moved
               THEN /\ wi' = [wi EXCEPT ![i] = nextWi]
                    /\ nextWi' = nextWi + 1
                    /\ wSeen' = Max(wSeen, nextWi)
               ELSE UNCHANGED <<wi, nextWi, wSeen>>
    /\ fh' = [fh EXCEPT ![i] = disk]
    /\ qlock' = IF FixQueue /\ FixQueueRefresh /\ ~(FixHoldWriter /\ orphanW[i])
                   THEN "none" ELSE qlock
    /\ hpc' = [hpc EXCEPT ![i] = "analyse"]
    /\ UNCHANGED <<disk, applied, blk, agentI, agentPc, abuf, hsh, fbuf,
                   aband, jt, regMap, latch, widget, inl, itok>>
    /\ UNCHANGED orphanW

\* dispatchLintWithResult returns; recordDiagnostics (widget store).
Analyse(i) ==
    /\ hpc[i] = "analyse"
    /\ IF ~WidgetGuard \/ wi[i] >= wSeen
         THEN /\ widget' = ct[i]
              /\ wSeen' = Max(wSeen, wi[i])
         ELSE UNCHANGED <<widget, wSeen>>
    /\ hpc' = [hpc EXCEPT ![i] = "release"]
    /\ UNCHANGED <<disk, applied, blk, agentI, agentPc, abuf, qlock, hsh, wi, ct,
                   fbuf, fixedBy, fh, aband, jt, nextWi, regMap, latch, inl, itok>>
    /\ UNCHANGED orphanW

\* releaseInFlightPipeline (by hash key) and the already-analysed latch.
Release(i) ==
    /\ hpc[i] = "release"
    /\ regMap' = {x \in regMap : x[1] # hsh[i]}
    /\ latch' = IF fixedBy[i] THEN fh[i] ELSE hsh[i]
    /\ hpc' = [hpc EXCEPT ![i] = "record"]
    /\ UNCHANGED <<disk, applied, blk, agentI, agentPc, abuf, qlock, hsh, wi, ct,
                   fbuf, fixedBy, fh, aband, jt, nextWi, widget, wSeen, inl, itok>>
    /\ UNCHANGED orphanW

\* The handler records (blocker) or clears (clean) the inline-blocker record.
\* An abandoned handler returned already and records nothing.
Record(i) ==
    /\ hpc[i] = "record"
    /\ LET b == Blocker(ct[i])
           t == wi[i]
           last == IF FixTomb THEN itok ELSE (IF inl.has THEN inl.tok ELSE 0)
           ok == IF b THEN (~FixRecord \/ t >= last) ELSE (~FixClear \/ t >= last)
       IN IF ~aband[i] /\ ok
            THEN /\ inl' = [has |-> b, c |-> ct[i], tok |-> t]
                 /\ itok' = Max(itok, t)
            ELSE UNCHANGED <<inl, itok>>
    /\ hpc' = [hpc EXCEPT ![i] = "done"]
    /\ UNCHANGED <<disk, applied, blk, agentI, agentPc, abuf, qlock, hsh, wi, ct,
                   fbuf, fixedBy, fh, aband, jt, nextWi, regMap, latch, widget, wSeen>>
    /\ UNCHANGED orphanW

\* A joined duplicate awaits the pipeline it joined, then returns.
JoinDone(i) ==
    /\ hpc[i] = "join"
    /\ hpc[jt[i]] \in {"record", "done"} \/ aband[i]
    /\ hpc' = [hpc EXCEPT ![i] = "done"]
    /\ UNCHANGED <<disk, applied, blk, agentI, agentPc, abuf, qlock, hsh, wi, ct,
                   fbuf, fixedBy, fh, aband, jt, nextWi, regMap, latch, widget, wSeen,
                   inl, itok>>
    /\ UNCHANGED orphanW

\* The handler's 10 s bound fires; the pipeline keeps running.
Abandon(i) ==
    /\ Orphan
    /\ hpc[i] \notin {"idle", "done"} /\ ~aband[i]
    /\ aband' = [aband EXCEPT ![i] = TRUE]
    /\ UNCHANGED <<disk, applied, blk, agentI, agentPc, abuf, qlock, hpc, hsh, wi, ct,
                   fbuf, fixedBy, fh, jt, nextWi, regMap, latch, widget, wSeen, inl, itok>>
    /\ UNCHANGED orphanW

\* The writer's own bound gives up on it (format-service.ts
\* runFormattersWithConcurrency: `bounded`, per-file budget 10 s) while its
\* in-place child (formatters.ts formatFile, 15 s spawn timeout) runs on; the
\* pipeline carries on to its refresh as if the writer had returned.
WriterAbandon(i) ==
    /\ WriterBound
    /\ hpc[i] = "fixwrite"
    /\ orphanW' = [orphanW EXCEPT ![i] = TRUE]
    /\ hpc' = [hpc EXCEPT ![i] = "refresh"]
    /\ qlock' = IF FixQueue /\ ~FixQueueRefresh THEN "none" ELSE qlock
    /\ UNCHANGED <<disk, applied, blk, agentI, agentPc, abuf, hsh, wi, ct, fbuf,
                   fixedBy, fh, aband, jt, nextWi, regMap, latch, widget, wSeen,
                   inl, itok>>

\* The abandoned child writes its fix of what it read. Under FixHoldWriter
\* the hold its pipeline already released waits for this settle
\* (file-mutation-queue.ts `outlive`).
OrphanWrite(i) ==
    /\ orphanW[i]
    /\ disk' = [e |-> fbuf[i].e, f |-> TRUE]
    /\ orphanW' = [orphanW EXCEPT ![i] = FALSE]
    /\ qlock' = IF FixQueue /\ FixQueueRefresh /\ FixHoldWriter /\ hpc[i] # "refresh"
                 THEN "none" ELSE qlock
    /\ UNCHANGED <<applied, blk, agentI, agentPc, abuf, hpc, hsh, wi, ct, fbuf,
                   fixedBy, fh, aband, jt, nextWi, regMap, latch, widget, wSeen,
                   inl, itok>>

Next ==
    \/ AgentRead \/ AgentWrite
    \/ \E i \in Pipes :
         Hash(i) \/ Start(i) \/ FixRead(i) \/ FixWrite(i) \/ Refresh(i)
         \/ Analyse(i) \/ Release(i) \/ Record(i) \/ JoinDone(i) \/ Abandon(i)
         \/ WriterAbandon(i) \/ OrphanWrite(i)

Spec == Init /\ [][Next]_vars

----------------------------------------------------------------------------
Quiescent == agentPc = "done" /\ \A i \in Pipes : hpc[i] = "done" /\ ~orphanW[i]

\* An autofix never overwrites an agent edit (pi-coding-agent docs/extensions.md
\* ~1925: a file-mutating extension must use withFileMutationQueue).
NoLostEdit == \A i \in applied : i \in disk.e

\* What the pipeline reports as its own autofix write (fileModified, the
\* "pi-lens applied autofix ... authoritative" attachment, the change-log
\* `autofix` receipt, postWriteStateHash -> the already-analysed latch) holds no
\* agent edit the fixer did not read (pipeline.ts ~1576-1600).
NoForeignAttribution == \A i \in Pipes : fixedBy[i] => fh[i].e = fbuf[i].e

\* The widget store ends on the newest revision (widget-state.ts ~305-315).
WidgetNewest == Quiescent => widget.e = disk.e

\* Stronger: the widget ends on exactly the bytes on disk, including pi-lens'
\* own fix (a verdict on pre-fix bytes re-reports what the autofix fixed).
WidgetExact == Quiescent => widget = disk

\* The turn-end inline-blocker record (and the git-guard latch built from it)
\* ends on the newest revision: "a slow old clean ... must not erase" a newer
\* blocker (runtime-coordinator.ts ~158-163, ~1353-1356, #1198 invariants 1-2).
InlineNewest ==
    Quiescent => /\ inl.has = Blocker(disk)
                 /\ inl.has => inl.c.e = disk.e

\* Stronger: the record's verdict is about exactly the bytes on disk.
InlineExact ==
    Quiescent => /\ inl.has = Blocker(disk)
                 /\ inl.has => inl.c = disk

\* No two pipelines analyse one (file, state) concurrently
\* (runtime-tool-result.ts ~402-431: the claim is atomic with registration).
Running(i) == hpc[i] \in {"gap", "fixread", "fixwrite", "refresh", "analyse", "release"}
NoDoubleDispatch ==
    \A i, j \in Pipes : (i # j /\ Running(i) /\ Running(j)) => hsh[i] # hsh[j]
=============================================================================
