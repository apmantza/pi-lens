---------------------------- MODULE FormatDrain ----------------------------
(***************************************************************************)
(* One file F and the deferred format/autofix drain that pi-lens runs at    *)
(* `agent_settled` (index.ts runDeferredMutationDrain ->                    *)
(* runtime-agent-end.ts handleAgentEnd), against the next run, a session    *)
(* replacement and another pi-lens process. Issues #3527, #3528, #3529.     *)
(*                                                                          *)
(* Actors:                                                                  *)
(*  - the agent: Read (with #3576 R1, its read-warm touch: a stamped LSP  *)
(*    sync of the bytes it read, runtime-tool-call.ts ~833, outside pi's    *)
(*    queue), and Edit = guard check (read-guard.ts checkEdit:              *)
(*    a read this session, or wasWrittenThisSession), then a                *)
(*    read-modify-write under pi's per-file withFileMutationQueue           *)
(*    (core/tools/edit.js), then tool_result: recordWritten of its own      *)
(*    write, the deferred-format queue record, and the pipeline's LSP sync  *)
(*    of the bytes it read (stamped: #3481 last-read-wins).                 *)
(*  - pi: `_runAgentPrompt`'s finally awaits `_emitAgentSettled`, which     *)
(*    clears `_isAgentRunActive` BEFORE awaiting the extension handlers     *)
(*    (agent-session.js ~347). The interactive main loop awaits             *)
(*    session.prompt, so its next prompt waits for the drain; an RPC prompt *)
(*    is `void session.prompt` (rpc-mode.js ~302) and a host that polls     *)
(*    isStreaming/waitForIdle does not wait (Overlap). `/new` runs from the *)
(*    editor's submit callback, so it runs while the drain runs; the drain  *)
(*    has no abort signal then.                                             *)
(*  - the drain handler (one file): the session capture and the claim       *)
(*    (handleAgentEnd), then runFormatPhase -> formatFile: resolve the      *)
(*    formatter's command (resolveCommand, which may auto-install; #3558),  *)
(*    enter pi's queue (#3610), read contentBefore, spawn the in-place      *)
(*    formatter (it reads and writes F), read contentAfter,                 *)
(*    changed := before # after; then fileContent is read (runFormatPhase); *)
(*    then the apply loop: recordProjectChange, recordWritten,              *)
(*    addModifiedRange, turnSummary, and resyncLspFile(fileContent,         *)
(*    fileReadStamp).                                                       *)
(*    FixQueue: the #3561 format hold is entered (EnterAfterResolve: after  *)
(*    the resolution, #3610; before it, the pre-#3610 code) and released    *)
(*    when the phase settles, after the fileContent read.                   *)
(*    The per-file wait is `bounded(..., 10 s)`: on expiry the handler      *)
(*    requeues and moves on while the formatter run keeps going, whether    *)
(*    it is resolving, waiting to enter or writing (Orphan).                *)
(*    FixQueueHold: the hold's release follows the phase, not the bound,    *)
(*    so the child keeps the queue until it has written.                    *)
(*    FixOrphanSync: once that child has exited, a fresh read of F is taken *)
(*    and later sent to the LSP; the read and the send are separate steps,  *)
(*    as in the code. OrphanSyncBound (#3728): that wait is itself bounded  *)
(*    by DEFERRED_FORMAT_BUDGET_MS; it gives up while the run is alive.     *)
(*    OrphanLateSync (#3828): the give-up chains the same read and send     *)
(*    onto the run's settlement, so the late write is still synced.         *)
(*    InBand (#3858): the run's caller is the tool_result pipeline          *)
(*    (--immediate-format), which waits for nothing after the bound: it     *)
(*    goes on to read fileContent and send it (the pre-format bytes), and   *)
(*    the abandoned run writes later. The give-up is the bound's own        *)
(*    expiry (`gaveUp` at `Abandon`), and OrphanLateSync is the same chain  *)
(*    at that call site (pipeline.ts `analysePipeline`).                    *)
(*  - /new: resetForSession (runtime-coordinator.ts ~447) on the module-    *)
(*    level `runtime`: fresh read guard, cleared queue, generation + 1; and *)
(*    the LSP service is retired (resetLSPService), so the next touch opens *)
(*    a fresh document and a drain touch after it would spawn a server for  *)
(*    the next session (#3528 r1 F1). LspGen: the drain's sends run only    *)
(*    while its session is current. StartGen: nor does it start formatting  *)
(*    a file after that (the format worker's and the autofix loop's start   *)
(*    check): its write could not be synced to the next session's LSP.      *)
(*  - a retire of the LSP service WITHOUT a session bump (#3576):           *)
(*    session_shutdown or the idle reset. ServiceGen: the drain's sends     *)
(*    also check the service generation it captured (lsp-launch-            *)
(*    availability, bumped by every resetLSPService). HeldResync (R1): a    *)
(*    drain send whose session or service was replaced goes only to a live  *)
(*    document, from a fresh read of F, and never opens one.                *)
(*  - another pi-lens process formatting F (not in this process's queue).   *)
(*                                                                          *)
(* The drain's autofix phase (runAutofix) has the same read/write/          *)
(* bookkeeping shape as the format phase and is not modelled separately.    *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS
    Edits,            \* agent edits of F
    MaxOps,           \* agent reads + edit attempts
    MaxTurns,         \* agent runs
    MaxSessions,      \* 1 + number of /new
    ExtWrites,        \* formats of F by another pi-lens process
    Overlap,          \* TRUE: next run may start while the drain runs (RPC / waitForIdle hosts)
    Orphan,           \* TRUE: the 10 s bound may abandon the formatter child
    MtimeAuthored,    \* TRUE: wasWrittenThisSession's mtime >= sessionStart fallback (#3520)
    ResetClearsGuard, \* FALSE: mutant, /new keeps the read guard
    FixQueue,         \* fix: contentBefore..fileContent (incl. the child) under withFileMutationQueue(F)
    FixQueueHold,     \* fix: an abandoned child keeps the queue until it exits
    FixGen,           \* fix: capture sessionGeneration at claim; session writes only when current
    GenDropsAll,      \* mutant: the generation guard drops every write, current or not
    FixStamp,         \* fix: the drain's LSP sends carry the stamp of their read
    LspGen,           \* fix (#3528 r1 F1): the drain's LSP sends run only while its session is current
    StartGen,         \* fix (#3528 r1 F1): a drain whose session was replaced starts no new format
    FixOrphanSync,    \* fix: an abandoned child's exit is followed by a stamped read + resync
    IdleRetire,       \* TRUE: the LSP service may be retired without a session bump (#3576)
    ServiceGen,       \* fix (#3576): the drain's sends also check the LSP service generation
    HeldResync,       \* fix (#3576 R1): a replaced drain resyncs only a live document, fresh read
    EnterAfterResolve, \* fix (#3610): the formatter enters pi's queue after its command resolution
    OrphanSyncBound,  \* TRUE: the post-exit wait gives up after DEFERRED_FORMAT_BUDGET_MS (#3728)
    OrphanLateSync,   \* fix (#3828, #3858): a give-up chains the fresh read + resync onto the run's settlement
    InBand            \* TRUE: the run's caller is the in-band tool_result pipeline (#3858); the bound leaves its tail running

Content == [e : SUBSET (1..Edits), f : BOOLEAN]
Fmt(c) == [e |-> c.e, f |-> TRUE]
Ed(c, i) == [e |-> c.e \cup {i}, f |-> FALSE]
Init0 == [e |-> {}, f |-> TRUE]

VARIABLES
    file, mtime, applied, qOwner,
    gen, sessions, turns, turn, ops,
    reads, written, sessStart,
    aop, tmp, nextEdit, queued,
    hs, dGen, before, after, changed, fc, fcStamp,
    sp, sub, oc, ocStamp, gaveUp,
    clock, lspC, lspLast, lspOpen, lspGen, retired,
    extS, ext, extLeft,
    badClaim, blind, crossWrite, ownDrop, lspCross, respawn,
    dLspGen

vars == <<file, mtime, applied, qOwner, gen, sessions, turns, turn, ops,
          reads, written, sessStart, aop, tmp, nextEdit, queued,
          hs, dGen, before, after, changed, fc, fcStamp, sp, sub, oc, ocStamp,
          gaveUp, clock, lspC, lspLast, lspOpen, lspGen, retired, extS, ext, extLeft,
          badClaim, blind, crossWrite, ownDrop, lspCross, respawn, dLspGen>>

drainVars == <<hs, dGen, before, after, changed, fc, fcStamp, dLspGen>>
subVars == <<sp, sub, oc, ocStamp, gaveUp>>
lspVars == <<clock, lspC, lspLast, lspOpen, lspGen, retired>>
extVars == <<extS, ext, extLeft>>
flagVars == <<badClaim, blind, crossWrite, ownDrop, lspCross, respawn>>
sessVars == <<gen, sessions, turns, turn, ops, reads, written, sessStart>>

\* LSP notify queue, #3481: a stamped send older than the last stamped send is
\* dropped; an unstamped send (stamp 0) always goes out and keeps the stamp.
Send(c, s) ==
    IF s = 0 THEN lspC' = c /\ lspLast' = lspLast /\ lspOpen' = TRUE
    ELSE IF s < lspLast THEN UNCHANGED <<lspC, lspLast, lspOpen>>
    ELSE lspC' = c /\ lspLast' = s /\ lspOpen' = TRUE

WriteFile(c) ==
    /\ file' = c
    /\ mtime' = IF c = file THEN mtime ELSE mtime + 1

Init ==
    /\ file = Init0 /\ mtime = 0 /\ applied = {} /\ qOwner = "none"
    /\ gen = 1 /\ sessions = 1 /\ turns = 1 /\ turn = "running" /\ ops = 0
    /\ reads = FALSE /\ written = FALSE /\ sessStart = 0
    /\ aop = "idle" /\ tmp = Init0 /\ nextEdit = 1 /\ queued = FALSE
    /\ hs = "none" /\ dGen = 0 /\ before = Init0 /\ after = Init0
    /\ changed = FALSE /\ fc = Init0 /\ fcStamp = 0
    /\ sp = "none" /\ sub = Init0 /\ oc = Init0 /\ ocStamp = 0 /\ gaveUp = FALSE
    /\ clock = 1 /\ lspC = Init0 /\ lspLast = 0 /\ lspOpen = TRUE
    /\ lspGen = 1 /\ retired = FALSE /\ dLspGen = 0
    /\ extS = "idle" /\ ext = Init0 /\ extLeft = ExtWrites
    /\ badClaim = FALSE /\ blind = FALSE /\ crossWrite = FALSE /\ ownDrop = FALSE
    /\ lspCross = FALSE /\ respawn = FALSE

----------------------------------------------------------------------------
\* The agent

\* #3576 R1: the read-warm touch syncs the bytes read, stamped, outside pi's
\* queue; it opens a retired service's document again.
AgentRead ==
    /\ turn = "running" /\ aop = "idle" /\ ops < MaxOps
    /\ reads' = TRUE /\ ops' = ops + 1
    /\ Send(file, clock) /\ clock' = clock + 1
    /\ UNCHANGED <<file, mtime, applied, qOwner, gen, sessions, turns, turn,
                   written, sessStart, aop, tmp, nextEdit, queued,
                   drainVars, subVars, lspGen, retired, extVars, flagVars>>

WasWritten == written \/ (MtimeAuthored /\ mtime > sessStart)

EditCheck ==
    /\ turn = "running" /\ aop = "idle" /\ ops < MaxOps /\ nextEdit <= Edits
    /\ ops' = ops + 1
    /\ IF reads \/ WasWritten
         THEN aop' = "wait" /\ blind' = (blind \/ ~reads)
         ELSE UNCHANGED <<aop, blind>>
    /\ UNCHANGED <<file, mtime, applied, qOwner, gen, sessions, turns, turn,
                   reads, written, sessStart, tmp, nextEdit, queued,
                   drainVars, subVars, lspVars, extVars, badClaim, crossWrite,
                   ownDrop, lspCross, respawn>>

EditRead ==
    /\ aop = "wait" /\ qOwner = "none"
    /\ qOwner' = "agent" /\ tmp' = file /\ aop' = "write"
    /\ UNCHANGED <<file, mtime, applied, sessVars, nextEdit, queued,
                   drainVars, subVars, lspVars, extVars, flagVars>>

EditWrite ==
    /\ aop = "write"
    /\ WriteFile(Ed(tmp, nextEdit))
    /\ applied' = applied \cup {nextEdit}
    /\ nextEdit' = nextEdit + 1
    /\ qOwner' = "none"
    /\ written' = TRUE          \* tool_result recordWritten of its own write
    /\ queued' = TRUE           \* deferred format record
    /\ aop' = "sync"
    /\ UNCHANGED <<gen, sessions, turns, turn, ops, reads, sessStart, tmp,
                   drainVars, subVars, lspVars, extVars, flagVars>>

\* the edit's pipeline reads F and touches the LSP with that read's stamp
EditSync ==
    /\ aop = "sync"
    /\ Send(file, clock) /\ clock' = clock + 1
    /\ aop' = "idle"
    /\ UNCHANGED <<file, mtime, applied, qOwner, sessVars, tmp, nextEdit, queued,
                   drainVars, subVars, lspGen, retired, extVars, flagVars>>

----------------------------------------------------------------------------
\* Run boundaries, /new

DrainIdle == hs \in {"none", "done"}

\* agent_end ... agent_settled: the drain captures the session and claims
EndRun ==
    /\ turn = "running" /\ aop = "idle"
    /\ turn' = "settled"
    /\ IF queued /\ DrainIdle /\ sp = "none"
         THEN hs' = "before" /\ dGen' = gen /\ dLspGen' = lspGen /\ queued' = FALSE
         ELSE UNCHANGED <<hs, dGen, dLspGen, queued>>
    /\ UNCHANGED <<file, mtime, applied, qOwner, gen, sessions, turns, ops,
                   reads, written, sessStart, aop, tmp, nextEdit,
                   before, after, changed, fc, fcStamp, subVars,
                   lspVars, extVars, flagVars>>

StartRun ==
    /\ turn = "settled" /\ turns < MaxTurns
    /\ Overlap \/ DrainIdle
    /\ turn' = "running" /\ turns' = turns + 1
    /\ UNCHANGED <<file, mtime, applied, qOwner, gen, sessions, ops,
                   reads, written, sessStart, aop, tmp, nextEdit, queued,
                   drainVars, subVars, lspVars, extVars, flagVars>>

NewSession ==
    /\ turn = "settled" /\ aop = "idle" /\ sessions < MaxSessions
    /\ gen' = gen + 1 /\ sessions' = sessions + 1
    /\ reads' = FALSE
    /\ written' = IF ResetClearsGuard THEN FALSE ELSE written
    /\ sessStart' = mtime
    /\ queued' = FALSE            \* _pendingDeferredMutations.clear()
    /\ lspOpen' = FALSE /\ lspLast' = 0   \* resetLSPService: a fresh service
    /\ lspGen' = lspGen + 1
    /\ UNCHANGED <<file, mtime, applied, qOwner, turns, turn, ops, aop, tmp,
                   nextEdit, drainVars, subVars, clock, lspC, retired, extVars,
                   flagVars>>

\* #3576: session_shutdown or the idle reset retires the LSP service without
\* bumping the session generation (at most once here).
Retire ==
    /\ IdleRetire /\ ~retired
    /\ retired' = TRUE
    /\ lspOpen' = FALSE /\ lspLast' = 0 /\ lspGen' = lspGen + 1
    /\ UNCHANGED <<file, mtime, applied, qOwner, sessVars, aop, tmp, nextEdit,
                   queued, drainVars, subVars, clock, lspC, extVars, flagVars>>

----------------------------------------------------------------------------
\* The drain

\* guardedWrite: the write runs only while the captured session is current.
Current ==
    IF GenDropsAll THEN FALSE ELSE (~FixGen \/ dGen = gen)

\* #3528 r1 F1: the drain's LSP sends go through the same session guard;
\* #3576: and through the LSP service generation it captured.
LspCurrent ==
    IF GenDropsAll THEN FALSE
    ELSE (~LspGen \/ dGen = gen) /\ (~ServiceGen \/ dLspGen = lspGen)

\* A drain send. Current: it sends its own read. A send that opens the next
\* session's document is a cross-session write, and one that opens a
\* document on a service retired since the drain started is a respawn
\* (#234). Stale, under HeldResync (#3576 R1): only a document a live client
\* already holds is resynced, from a fresh read of F; nothing is opened.
DrainSend(c, s) ==
    IF LspCurrent
      THEN /\ Send(c, s)
           /\ clock' = clock
           /\ lspCross' = (lspCross \/ (dGen # gen /\ ~lspOpen))
           /\ respawn' = (respawn \/ (dLspGen # lspGen /\ ~lspOpen))
    ELSE IF HeldResync /\ lspOpen
      THEN /\ Send(file, clock) /\ clock' = clock + 1
           /\ UNCHANGED <<lspCross, respawn>>
    ELSE UNCHANGED <<lspC, lspLast, lspOpen, clock, lspCross, respawn>>

\* The format worker's start check: a replaced session's drain skips the file.
Replaced == StartGen /\ dGen # gen

DSkip ==
    /\ hs = "before" /\ Replaced
    /\ hs' = "done"
    /\ UNCHANGED <<file, mtime, applied, qOwner, sessVars, aop, tmp, nextEdit,
                   queued, dGen, dLspGen, before, after, changed, fc, fcStamp,
                   subVars, lspVars, extVars, flagVars>>

\* The format worker starts the formatter run. The run resolves its command
\* first (`resolveCommand`: an auto-install can take minutes), OUTSIDE pi's
\* queue (#3558). Before #3610 (EnterAfterResolve = FALSE) the hold was taken
\* here, so an install held pi's queue.
DStart ==
    /\ hs = "before" /\ ~Replaced
    /\ (FixQueue /\ ~EnterAfterResolve) => qOwner = "none"
    /\ qOwner' = IF FixQueue /\ ~EnterAfterResolve THEN "drain" ELSE qOwner
    /\ hs' = "wait" /\ sp' = "resolve" /\ gaveUp' = FALSE
    /\ UNCHANGED <<file, mtime, applied, sessVars, aop, tmp, nextEdit, queued,
                   dGen, dLspGen, before, after, changed, fc, fcStamp,
                   sub, oc, ocStamp, lspVars, extVars, flagVars>>

SubResolved ==
    /\ sp = "resolve"
    /\ sp' = "enter"
    /\ UNCHANGED <<file, mtime, applied, qOwner, sessVars, aop, tmp, nextEdit,
                   queued, drainVars, sub, oc, ocStamp, gaveUp, lspVars, extVars,
                   flagVars>>

\* #3610: `formatFile` calls `enter()` after the resolution and before the
\* contentBefore read. A run the bound gave up on during its resolution enters
\* later, in a queue entry of its own that lasts until it settles.
SubEnter ==
    /\ sp = "enter"
    /\ (FixQueue /\ EnterAfterResolve) => qOwner = "none"
    /\ qOwner' = IF FixQueue /\ EnterAfterResolve THEN "drain" ELSE qOwner
    /\ before' = file
    /\ sp' = "start"
    /\ UNCHANGED <<file, mtime, applied, sessVars, aop, tmp, nextEdit, queued,
                   dGen, dLspGen, after, changed, fc, fcStamp, hs, sub, oc,
                   ocStamp, gaveUp, lspVars, extVars, flagVars>>

SubRead ==
    /\ sp = "start"
    /\ sub' = file /\ sp' = "run"
    /\ UNCHANGED <<file, mtime, applied, qOwner, sessVars, aop, tmp, nextEdit,
                   queued, drainVars, oc, ocStamp, gaveUp, lspVars, extVars,
                   flagVars>>

\* the formatter child writes its format of what it read; an abandoned child
\* releases the hold it kept (FixQueueHold) once it has written. A run whose
\* post-exit wait gave up (gaveUp) is synced only with OrphanLateSync (#3828):
\* the merged #3728 code abandoned that resync and never read or sent again.
SubWrite ==
    /\ sp = "run"
    /\ WriteFile(Fmt(sub))
    /\ sp' = IF hs = "wait" THEN "exited"
             ELSE IF FixOrphanSync /\ (~gaveUp \/ OrphanLateSync) THEN "oread"
             ELSE "none"
    /\ qOwner' = IF hs # "wait" /\ qOwner = "drain" THEN "none" ELSE qOwner
    /\ UNCHANGED <<applied, sessVars, aop, tmp, nextEdit, queued,
                   drainVars, sub, oc, ocStamp, gaveUp, lspVars, extVars,
                   flagVars>>

\* fix: the post-exit read of F, stamped ...
OrphanRead ==
    /\ sp = "oread"
    /\ oc' = file /\ ocStamp' = clock /\ clock' = clock + 1
    /\ sp' = "osend"
    /\ UNCHANGED <<file, mtime, applied, qOwner, sessVars, aop, tmp, nextEdit,
                   queued, drainVars, sub, gaveUp, lspC, lspLast, lspOpen, lspGen,
                   retired, extVars, flagVars>>

\* ... and, later, its send
OrphanSend ==
    /\ sp = "osend"
    /\ DrainSend(oc, IF FixStamp THEN ocStamp ELSE 0)
    /\ sp' = "none"
    /\ UNCHANGED <<file, mtime, applied, qOwner, sessVars, aop, tmp, nextEdit,
                   queued, drainVars, sub, oc, ocStamp, gaveUp, lspGen, retired,
                   extVars, badClaim, blind, crossWrite, ownDrop>>

DAfter ==
    /\ hs = "wait" /\ sp = "exited"
    /\ after' = file
    /\ changed' = (before # file)
    /\ sp' = "none"
    /\ hs' = "fc"
    /\ UNCHANGED <<file, mtime, applied, qOwner, sessVars, aop, tmp, nextEdit,
                   queued, dGen, dLspGen, before, fc, fcStamp, sub, oc, ocStamp,
                   gaveUp, lspVars, extVars, flagVars>>

\* bounded() expires: requeue "format-failed", move on; the run goes on (it may
\* still be resolving its command, waiting to enter, or writing). InBand (#3858):
\* the caller is the tool_result pipeline, which requeues nothing and goes on to
\* its tail (DFc, DApply: the fileContent read and the LSP send of the bytes
\* from before the run's write) with the run still alive; the bound's expiry is
\* the give-up, so a late write is synced only with OrphanLateSync.
Abandon ==
    /\ Orphan /\ hs = "wait" /\ sp \in {"resolve", "enter", "start", "run"}
    /\ hs' = IF InBand THEN "fc" ELSE "done"
    /\ gaveUp' = InBand
    /\ changed' = IF InBand THEN FALSE ELSE changed   \* the phase reports no format
    /\ queued' = IF Current /\ ~InBand THEN TRUE ELSE queued
    /\ crossWrite' = (crossWrite \/ (~InBand /\ Current /\ dGen # gen))
    /\ ownDrop' = (ownDrop \/ (~InBand /\ ~Current /\ dGen = gen))
    /\ qOwner' = IF qOwner = "drain" /\ ~FixQueueHold THEN "none" ELSE qOwner
    /\ UNCHANGED <<file, mtime, applied, sessVars, aop, tmp, nextEdit,
                   dGen, dLspGen, before, after, fc, fcStamp,
                   sp, sub, oc, ocStamp,
                   lspVars, extVars, badClaim, blind, lspCross, respawn>>

\* #3728: the post-exit wait is bounded by DEFERRED_FORMAT_BUDGET_MS and gives
\* up while the abandoned run is still alive. Without OrphanLateSync it reports
\* "abandoned" and the run's later write is never read or sent (SubWrite).
OrphanGiveUp ==
    /\ OrphanSyncBound /\ hs # "wait" /\ ~gaveUp
    /\ sp \in {"resolve", "enter", "start", "run"}
    /\ gaveUp' = TRUE
    /\ UNCHANGED <<file, mtime, applied, qOwner, sessVars, aop, tmp, nextEdit,
                   queued, drainVars, sp, sub, oc, ocStamp, lspVars, extVars,
                   flagVars>>

\* the phase reads fileContent (with its stamp) inside the hold, then settles
\* and the hold is released. An abandoned run keeps its own queue entry until
\* it has written (SubWrite), so a tail reached through Abandon (InBand) does
\* not release it.
DFc ==
    /\ hs = "fc"
    /\ fc' = file /\ fcStamp' = clock /\ clock' = clock + 1
    /\ qOwner' = IF qOwner = "drain" /\ sp = "none" THEN "none" ELSE qOwner
    /\ hs' = "apply"
    /\ UNCHANGED <<file, mtime, applied, sessVars, aop, tmp, nextEdit,
                   queued, dGen, dLspGen, before, after, changed, subVars,
                   lspC, lspLast, lspOpen, lspGen, retired, extVars, flagVars>>

DApply ==
    /\ hs = "apply"
    /\ badClaim' = (badClaim \/ (changed /\ after.e # before.e))
    /\ written' = IF changed /\ Current THEN TRUE ELSE written
    /\ crossWrite' = (crossWrite \/ (changed /\ Current /\ dGen # gen))
    /\ ownDrop' = (ownDrop \/ (changed /\ ~Current /\ dGen = gen))
    /\ DrainSend(fc, IF FixStamp THEN fcStamp ELSE 0)
    /\ hs' = "done"
    /\ UNCHANGED <<file, mtime, applied, qOwner, gen, sessions, turns, turn, ops,
                   reads, sessStart, aop, tmp, nextEdit, queued,
                   dGen, dLspGen, before, after, changed, fc, fcStamp, subVars,
                   lspGen, retired, extVars, blind>>

----------------------------------------------------------------------------
\* Another pi-lens process formats F (its own queue, not ours)

ExtRead ==
    /\ extS = "idle" /\ extLeft > 0
    /\ ext' = file /\ extS' = "run"
    /\ UNCHANGED <<file, mtime, applied, qOwner, sessVars, aop, tmp, nextEdit,
                   queued, drainVars, subVars, lspVars, extLeft, flagVars>>

ExtWrite ==
    /\ extS = "run"
    /\ WriteFile(Fmt(ext))
    /\ extS' = "idle" /\ extLeft' = extLeft - 1
    /\ UNCHANGED <<applied, qOwner, sessVars, aop, tmp, nextEdit,
                   queued, drainVars, subVars, lspVars, ext, flagVars>>

Next ==
    \/ AgentRead \/ EditCheck \/ EditRead \/ EditWrite \/ EditSync
    \/ EndRun \/ StartRun \/ NewSession
    \/ DSkip \/ DStart \/ SubResolved \/ SubEnter \/ SubRead \/ SubWrite
    \/ DAfter \/ Abandon \/ OrphanGiveUp
    \/ OrphanRead \/ OrphanSend
    \/ DFc \/ DApply
    \/ Retire
    \/ ExtRead \/ ExtWrite

Spec == Init /\ [][Next]_vars

----------------------------------------------------------------------------
\* Invariants

TypeOK ==
    /\ file \in Content /\ applied \subseteq 1..Edits
    /\ qOwner \in {"none", "agent", "drain"}
    /\ hs \in {"none", "before", "wait", "fc", "apply", "done"}
    /\ sp \in {"none", "resolve", "enter", "start", "run", "exited", "oread",
               "osend"}
    /\ gaveUp \in BOOLEAN
    /\ lspOpen \in BOOLEAN /\ retired \in BOOLEAN

\* The drain never overwrites an agent edit (pi docs/extensions.md ~1925).
NoLostEdit == applied \subseteq file.e

\* What the drain reports as its format (summary.changed, the "formatted"
\* notice, the publishFilesTouched `fixes` provenance, recordWritten) holds
\* no agent edit: before -> after is formatting only.
HonestFormatClaim == ~badClaim

\* Once everything is quiet, an open LSP document holds the bytes on disk. This
\* is also the no-drop direction of the stamp filter and of the session guard
\* on the drain's sends: a send dropped although it carried the newest read
\* leaves the LSP behind the disk. A retired service (after /new) has no open
\* document until its session's next touch.
Quiet == aop = "idle" /\ DrainIdle /\ sp = "none" /\ extS = "idle"
LspMatchesDisk == (Quiet /\ lspOpen) => lspC = file

\* An edit is admitted only after this session showed the agent F
\* (read-guard.ts header: "Read state from session 1 never authorises session 2").
NoBlindAllow == ~blind

\* Shape 22: a drain claimed in one session never writes the next
\* session's state (read guard, pending queue, project change log), and never
\* opens a document in its fresh LSP service (#3528 r1 F1). The #3576 R1
\* resync of a document the next session already holds, to the bytes on disk,
\* is not such a write: it opens nothing.
NoCrossSessionWrite == ~crossWrite /\ ~lspCross

\* #234, #3576: a drain never opens a document on an LSP service that was
\* retired since it started (session_shutdown, the idle reset): that open
\* spawns a server nobody asked for.
NoDrainRespawn == ~respawn

\* Shape 54, the generation guard's no-drop direction: a drain that is still
\* in the session it claimed in keeps every session write (recordWritten,
\* requeue).
NoOwnDrop == ~ownDrop

\* #3558, #3610: an agent edit never waits on pi's queue while the formatter
\* only resolves its command (an auto-install runs for minutes). Before #3610
\* the hold was entered before the resolution.
NoInstallHold == ~(aop = "wait" /\ qOwner = "drain" /\ sp = "resolve")
=============================================================================
