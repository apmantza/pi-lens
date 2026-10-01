---------------------------- MODULE LspRenameEdit ----------------------------
(***************************************************************************)
(* A language server computes a WorkspaceEdit from its own view of each    *)
(* file, and pi-lens applies it to the bytes on disk later. This model     *)
(* checks whether the edit can land on bytes other than the ones the       *)
(* server computed from, and whether a refused edit writes anything.       *)
(*                                                                         *)
(* Two flows:                                                              *)
(*  - "rename": lsp_navigation `rename` with apply (tools/lsp-navigation.ts)*)
(*    reads and sends the target (openFileBestEffort), takes T just before *)
(*    the request, binds every file the edit writes text to                *)
(*    (captureRenameExpectedContent), then applies under the queues.       *)
(*  - "renameFile": LSPService.renameFile (clients/lsp/index.ts) asks      *)
(*    every server for willRenameFiles, applies the merged text edits,     *)
(*    closes the old document, then moves the file.                        *)
(*                                                                         *)
(* The server's view of a file:                                            *)
(*  - opened (the client holds a send record): the last send, delivered in *)
(*    order on the same connection as the request;                         *)
(*  - unopened: the copy it read at project load. Init is the loaded       *)
(*    project, so every later write is after load (the #3736 round-3       *)
(*    lesson: tsserver reads unopened files at load, not after the         *)
(*    request). Its own file watching is not modelled unless               *)
(*    WatcherPrompt; see the README for why omitting it is sound.          *)
(*                                                                         *)
(* Writers:                                                                *)
(*  - pi's queued writers (the agent's edit and write, the formatter since *)
(*    #3610): a write, then a touchFile sync that may land late or never   *)
(*    (the pipeline syncs after its format and fix phases). Under          *)
(*    SyncCarriesRead the sync carries the bytes its pipeline wrote, and a *)
(*    stamped sync older than the last stamped one sent is dropped (#3481); *)
(*    otherwise it sends the current disk;                                 *)
(*  - an external writer: no queue, no sync, optionally keeping the mtime. *)
(* A read auto-touch or a cascade touch sends the disk bytes without a     *)
(* write; for an unopened file it is the didOpen. Under Revert a write may *)
(* restore bytes a file held before (A-B-A); otherwise every write is new. *)
(*                                                                         *)
(* ApplyEdit stands in for the LspEdit writer contract, which lane L5 owns *)
(* in formal/dispatch-pipeline (#3803): under the queues of every touched  *)
(* path, compare each expected content with the disk before any write,    *)
(* then write. It is one step unless SplitApply, which lets an unqueued    *)
(* writer land between the compare and the write, as the code allows.     *)
(***************************************************************************)
EXTENDS Naturals

CONSTANTS
    Files,          \* files the edit writes text to
    Target,         \* the rename's own file (a model value outside Files for renameFile)
    Opened,         \* files the client has open at the start
    Flow,           \* "rename" | "renameFile"
    Rule,           \* how each file is bound before the apply:
                    \*  "none"   no expectedContent (before #3736; renameFile on master, #3734)
                    \*  "r1"     every file bound to a read at capture, no refusal (round 1)
                    \*  "r2"     opened: disk = last send; unopened: refused (round 2)
                    \*  "r3"     opened: disk = last send; unopened: mtime rule (round 3)
                    \*  "merged" r3 plus the send-change stamp: refuse an opened file
                    \*           whose send changed at or after T (round 4, master)
    PiWriteFiles,   \* files pi's queued writers may write
    ExternalFiles,  \* files an external writer may write
    TouchFiles,     \* files a read auto-touch or a cascade touch may send from disk (no write)
    KeepMtime,      \* TRUE: an external write may keep the file's old mtime
    WatcherPrompt,  \* TRUE: the server's watcher delivers an external write to an unopened file at once
    AbortAfterText, \* renameFile: didClose or the resource move may fail after the text edits
    Revert,         \* TRUE: a write may restore earlier bytes (A-B-A)
    SyncCarriesRead,\* TRUE: a pi sync sends its own pipeline's bytes, not the current disk
    SplitApply,     \* TRUE: an unqueued writer may land between the apply's compare and write
    StampedPrepare, \* candidate: openFileBestEffort's send carries a readStamp (#3481)
    Margin,         \* RENAME_MTIME_MARGIN_MS, in clock ticks
    MaxWrites,
    MaxClock

NoSend == 0     \* sent[f] for a file the client has not opened; content ids start at 1

VARIABLES
    disk,       \* content id on disk
    mtime,
    sent,       \* the client's last send (NoSend: unopened)
    stamp,      \* changedAtMs: when a send last changed the sent bytes
    srv,        \* the server's view
    pending,    \* <<file, bytes, write order>> of pi writes whose sync has not run
                \* (<<file, 0, 0>> when the sync sends the current disk)
    stampedW,   \* write order of the last stamped pi sync sent, per file (#3481)
    nextId,
    clock,
    writes,
    phase,      \* "idle" | "prepared" | "requested" | "captured" | "compared"
                \*   | "textApplied" | "applied" | "refused" | "aborted"
    T,          \* the instant taken just before the request
    tContent,   \* the target bytes openFileBestEffort read and sent
    basis,      \* what the server computed the edit from
    expected,   \* the apply's expectedContent (0: not bound)
    wrote,      \* files this operation wrote
    stale,      \* files it wrote at offsets computed from other bytes
    refused,    \* files the refusal named
    inflight    \* files written after the operation began

vars == <<disk, mtime, sent, stamp, srv, pending, stampedW, nextId, clock, writes,
          phase, T, tContent, basis, expected, wrote, stale, refused, inflight>>

Init ==
    /\ disk = [f \in Files |-> 1]
    /\ mtime = [f \in Files |-> 0]
    /\ sent = [f \in Files |-> IF f \in Opened THEN 1 ELSE NoSend]
    /\ stamp = [f \in Files |-> 0]
    /\ srv = [f \in Files |-> 1]
    /\ pending = {}
    /\ stampedW = [f \in Files |-> 0]
    /\ nextId = 2
    /\ clock = Margin + 1     \* untouched files are older than the margin
    /\ writes = 0
    /\ phase = "idle"
    /\ T = 0
    /\ tContent = 0
    /\ basis = [f \in Files |-> 0]
    /\ expected = [f \in Files |-> 0]
    /\ wrote = {}
    /\ stale = {}
    /\ refused = {}
    /\ inflight = {}

Live == phase \in {"idle", "prepared", "requested", "captured"}
\* The operation has begun: a write now is concurrent with it.
InFlight == phase \in {"prepared", "requested", "captured", "compared"}

\* recordSentContent (clients/lsp/client.ts): the stamp moves only when the bytes change.
Send(f, c) ==
    /\ sent' = [sent EXCEPT ![f] = c]
    /\ stamp' = [stamp EXCEPT ![f] = IF sent[f] = c THEN @ ELSE clock]
    /\ srv' = [srv EXCEPT ![f] = c]

NewContent(f) == IF Revert THEN {c \in 1..nextId : c # disk[f]} ELSE {nextId}

Write(f, c, m) ==
    /\ disk' = [disk EXCEPT ![f] = c]
    /\ mtime' = [mtime EXCEPT ![f] = m]
    /\ nextId' = IF c = nextId THEN nextId + 1 ELSE nextId
    /\ writes' = writes + 1
    /\ inflight' = IF InFlight THEN inflight \union {f} ELSE inflight

Tick ==
    /\ Live /\ clock < MaxClock
    /\ clock' = clock + 1
    /\ UNCHANGED <<disk, mtime, sent, stamp, srv, pending, stampedW, nextId, writes,
                   phase, T, tContent, basis, expected, wrote, stale, refused, inflight>>

PiWrite(f) ==
    /\ Live /\ f \in PiWriteFiles /\ writes < MaxWrites
    /\ \E c \in NewContent(f) :
          /\ Write(f, c, clock)
          /\ pending' = pending \union
                {IF SyncCarriesRead THEN <<f, c, writes + 1>> ELSE <<f, 0, 0>>}
    /\ UNCHANGED <<sent, stamp, srv, stampedW, clock, phase, T, tContent, basis,
                   expected, wrote, stale, refused>>

\* The pipeline's touchFile: didChange for an open document, didOpen otherwise.
\* Its readStamp drops a stamped sync older than the last stamped one sent.
PiSync(p) ==
    /\ Live /\ p \in pending
    /\ pending' = pending \ {p}
    /\ IF ~SyncCarriesRead
         THEN /\ Send(p[1], disk[p[1]])
              /\ UNCHANGED stampedW
         ELSE IF p[3] < stampedW[p[1]]
           THEN UNCHANGED <<sent, stamp, srv, stampedW>>
           ELSE /\ Send(p[1], p[2])
                /\ stampedW' = [stampedW EXCEPT ![p[1]] = p[3]]
    /\ UNCHANGED <<disk, mtime, nextId, clock, writes, phase, T, tContent, basis,
                   expected, wrote, stale, refused, inflight>>

\* touchFile from a read or a cascade: the disk bytes, with no write and no readStamp.
Touch(f) ==
    /\ Live /\ f \in TouchFiles
    /\ Send(f, disk[f])
    /\ UNCHANGED <<disk, mtime, pending, stampedW, nextId, clock, writes, phase, T,
                   tContent, basis, expected, wrote, stale, refused, inflight>>

\* Unqueued, so it can also land inside a split apply.
ExternalWrite(f) ==
    /\ Live \/ phase = "compared"
    /\ f \in ExternalFiles /\ writes < MaxWrites
    /\ \E c \in NewContent(f), m \in IF KeepMtime THEN {clock, mtime[f]} ELSE {clock} :
          /\ Write(f, c, m)
          /\ srv' = IF WatcherPrompt /\ sent[f] = NoSend
                      THEN [srv EXCEPT ![f] = c] ELSE srv
    /\ UNCHANGED <<sent, stamp, pending, stampedW, clock, phase, T, tContent, basis,
                   expected, wrote, stale, refused>>

\* openFileBestEffort: read the target and send it. Its send carries no
\* readStamp; the StampedPrepare candidate stamps it with the writes so far.
Prepare ==
    /\ Flow = "rename" /\ phase = "idle"
    /\ tContent' = disk[Target]
    /\ Send(Target, disk[Target])
    /\ stampedW' = IF StampedPrepare
                     THEN [stampedW EXCEPT ![Target] = writes] ELSE stampedW
    /\ phase' = "prepared"
    /\ UNCHANGED <<disk, mtime, pending, nextId, clock, writes, T, basis,
                   expected, wrote, stale, refused, inflight>>

\* T is taken, and the server computes from its view.
Request ==
    /\ \/ Flow = "rename" /\ phase = "prepared"
       \/ Flow = "renameFile" /\ phase = "idle"
    /\ T' = clock
    /\ basis' = srv
    /\ phase' = "requested"
    /\ UNCHANGED <<disk, mtime, sent, stamp, srv, pending, stampedW, nextId, clock,
                   writes, tContent, expected, wrote, stale, refused, inflight>>

\* captureRenameExpectedContent, per Rule.
Refuses(f) ==
    IF Rule \in {"none", "r1"} \/ f = Target THEN FALSE
    ELSE IF sent[f] # NoSend
        THEN sent[f] # disk[f] \/ (Rule = "merged" /\ stamp[f] >= T)
    ELSE IF Rule = "r2" THEN TRUE
    ELSE mtime[f] + Margin >= T

Bound(f) ==
    IF Rule = "none" THEN 0
    ELSE IF f = Target THEN tContent
    ELSE disk[f]

Capture ==
    /\ phase = "requested"
    /\ IF \E f \in Files : Refuses(f)
         THEN /\ phase' = "refused"
              /\ refused' = {f \in Files : Refuses(f)}
              /\ UNCHANGED expected
         ELSE /\ expected' = [f \in Files |-> Bound(f)]
              /\ phase' = "captured"
              /\ UNCHANGED refused
    /\ UNCHANGED <<disk, mtime, sent, stamp, srv, pending, stampedW, nextId, clock,
                   writes, T, tContent, basis, wrote, stale, inflight>>

Mismatch == {f \in Files : expected[f] # 0 /\ expected[f] # disk[f]}

WriteAll ==
    /\ stale' = {f \in Files : basis[f] # disk[f]}
    /\ wrote' = Files
    /\ disk' = [f \in Files |-> nextId]
    /\ mtime' = [f \in Files |-> clock]
    /\ nextId' = nextId + 1
    /\ phase' = IF Flow = "rename" THEN "applied" ELSE "textApplied"

\* ApplyEdit: the LspEdit contract (see the header), refusing before any write.
ApplyEdit ==
    /\ phase = "captured"
    /\ IF Mismatch # {}
         THEN /\ phase' = "refused"
              /\ refused' = Mismatch
              /\ UNCHANGED <<disk, mtime, nextId, wrote, stale>>
         ELSE IF SplitApply
           THEN /\ phase' = "compared"
                /\ UNCHANGED <<disk, mtime, nextId, wrote, stale, refused>>
           ELSE /\ WriteAll
                /\ UNCHANGED refused
    /\ UNCHANGED <<sent, stamp, srv, pending, stampedW, clock, writes, T, tContent,
                   basis, expected, inflight>>

\* SplitApply: the write loop re-reads each file and writes it with no second compare.
ApplyWrite ==
    /\ phase = "compared"
    /\ WriteAll
    /\ UNCHANGED <<sent, stamp, srv, pending, stampedW, clock, writes, T, tContent,
                   basis, expected, refused, inflight>>

\* renameFile after its text edits: didClose fails, or the resource move's preflight does.
Abort ==
    /\ Flow = "renameFile" /\ AbortAfterText /\ phase = "textApplied"
    /\ phase' = "aborted"
    /\ UNCHANGED <<disk, mtime, sent, stamp, srv, pending, stampedW, nextId, clock,
                   writes, T, tContent, basis, expected, wrote, stale, refused, inflight>>

Move ==
    /\ Flow = "renameFile" /\ phase = "textApplied"
    /\ phase' = "applied"
    /\ UNCHANGED <<disk, mtime, sent, stamp, srv, pending, stampedW, nextId, clock,
                   writes, T, tContent, basis, expected, wrote, stale, refused, inflight>>

Next ==
    \/ Tick \/ Prepare \/ Request \/ Capture \/ ApplyEdit \/ ApplyWrite \/ Abort \/ Move
    \/ \E p \in pending : PiSync(p)
    \/ \E f \in Files : PiWrite(f) \/ Touch(f) \/ ExternalWrite(f)

Spec == Init /\ [][Next]_vars

-----------------------------------------------------------------------------
\* No stale apply: every byte range the edit wrote was computed from those bytes.
NoStaleApply == stale = {}

\* Atomic refusal: a refused or aborted operation wrote nothing.
AtomicRefusal == phase \in {"refused", "aborted"} => wrote = {}

\* The false refusals master accepts, per file: a changed send stamped in T's
\* own tick (the `>=` tie); an unopened file whose mtime is within the margin
\* of T, T's own tick included; and the target, which is held to the bytes
\* openFileBestEffort read even when the server has since caught up.
Accepted(f) ==
    \/ f = Target /\ disk[f] # tContent
    \/ f # Target /\ sent[f] # NoSend /\ Rule = "merged" /\ stamp[f] = T
    \/ f # Target /\ sent[f] = NoSend /\ Rule \in {"r3", "merged"}
       /\ mtime[f] + Margin >= T

\* Every file a refusal names would have taken a stale edit, or is an accepted
\* false refusal. A refusal names at least one file.
NoUnexplainedRefusal ==
    phase = "refused" =>
        /\ refused # {}
        /\ \A f \in refused : basis[f] # disk[f] \/ Accepted(f)

\* Reachability witness: a rename applies after a write concurrent with it.
NoAppliedAfterInFlightWrite == ~(phase = "applied" /\ inflight # {})
=============================================================================
