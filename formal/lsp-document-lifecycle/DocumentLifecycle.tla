------------------------- MODULE DocumentLifecycle -------------------------
(***************************************************************************)
(* One document's didOpen / didChange / didClose ordering between the LSP  *)
(* client (clients/lsp/client.ts) and a server, across a rename.           *)
(*                                                                         *)
(* Actors:                                                                 *)
(*  - touches: edits, cascade and warm-attach syncs of the old path, each  *)
(*    enqueued on the per-path notify queue (enqueueDocumentNotify), which *)
(*    coalesces unstarted entries;                                         *)
(*  - the queue runner: handleNotifyChangeOnce. If openDocuments has the   *)
(*    path it bumps the version and sends didChange; otherwise it sends a  *)
(*    fallback didOpen and marks the path open after the send resolves;    *)
(*  - rename (LSPService.renameFile): for a client whose isDocumentOpen is *)
(*    true, closeDocument sends didClose and deletes the path after the    *)
(*    send resolves. It does not go through the notify queue;              *)
(*  - the server, reading the client's messages in order.                  *)
(*                                                                         *)
(* vscode-jsonrpc orders messages when sendNotification is called, so a    *)
(* check and the send that follows it in the same tick are one step, and   *)
(* the bookkeeping after `await` is a separate step.                       *)
(***************************************************************************)
EXTENDS Naturals, Sequences

CONSTANTS
    Touches,        \* touches of the old path that may arrive
    TouchAfterRename, \* TRUE: a touch may arrive after rename started (carried-over cascade, warm attach)
    StartOpen,      \* TRUE: the document is open on both sides when rename starts
    QueuedClose     \* candidate fix: close runs on the path's notify queue, and a
                    \* closed path's queued entries are dropped, not reopened

VARIABLES
    clientOpen,     \* openDocuments.has(path)
    pending,        \* an unstarted queue entry exists (coalesced)
    runner,         \* "idle" | "openSent" | "changeSent" | "closeSent"
    touchesLeft,
    rename,         \* "before" | "closing" | "done"
    closedByRename, \* rename closed the path (closedDocuments)
    wire,           \* client-to-server messages not yet read
    serverOpen,
    violation       \* the first protocol violation the server saw, or "none"

vars == <<clientOpen, pending, runner, touchesLeft, rename, closedByRename, wire, serverOpen, violation>>

Init ==
    /\ clientOpen = StartOpen
    /\ pending = FALSE
    /\ runner = "idle"
    /\ touchesLeft = Touches
    /\ rename = "before"
    /\ closedByRename = FALSE
    /\ wire = << >>
    /\ serverOpen = StartOpen
    /\ violation = "none"

Send(m) == wire' = Append(wire, m)

Touch ==
    /\ touchesLeft > 0
    /\ rename = "before" \/ TouchAfterRename
    /\ touchesLeft' = touchesLeft - 1
    /\ pending' = TRUE
    /\ UNCHANGED <<clientOpen, runner, rename, closedByRename, wire, serverOpen, violation>>

\* The runner takes the pending entry: check openDocuments and send, one tick.
RunnerStart ==
    /\ runner = "idle"
    /\ pending
    /\ pending' = FALSE
    /\ IF QueuedClose /\ closedByRename
         THEN /\ runner' = "idle"            \* dropped: the path was renamed away
              /\ UNCHANGED wire
         ELSE IF clientOpen
           THEN /\ Send("didChange")
                /\ runner' = "changeSent"
           ELSE /\ Send("didOpen")
                /\ runner' = "openSent"
    /\ UNCHANGED <<clientOpen, touchesLeft, rename, closedByRename, serverOpen, violation>>

\* After the send resolves: the fallback open records the path as open.
RunnerFinish ==
    /\ runner \in {"openSent", "changeSent"}
    /\ clientOpen' = (IF runner = "openSent" THEN TRUE ELSE clientOpen)
    /\ runner' = "idle"
    /\ UNCHANGED <<pending, touchesLeft, rename, closedByRename, wire, serverOpen, violation>>

\* renameFile: only clients whose isDocumentOpen(old) is true are closed.
\* With QueuedClose the close is a notify-queue entry: it waits for the entry
\* in flight and reads openDocuments when it runs.
RenameStart ==
    /\ rename = "before"
    /\ QueuedClose => runner = "idle"
    /\ IF clientOpen
         THEN /\ Send("didClose")
              /\ rename' = "closing"
              /\ runner' = (IF QueuedClose THEN "closeSent" ELSE runner)
         ELSE /\ rename' = "done"
              /\ UNCHANGED <<wire, runner>>
    /\ closedByRename' = (IF clientOpen THEN closedByRename ELSE QueuedClose)
    /\ UNCHANGED <<clientOpen, pending, touchesLeft, serverOpen, violation>>

\* closeDocument after its didClose send resolves.
CloseFinish ==
    /\ rename = "closing"
    /\ QueuedClose => runner = "closeSent"
    /\ clientOpen' = FALSE
    /\ closedByRename' = TRUE
    /\ rename' = "done"
    /\ runner' = IF QueuedClose THEN "idle" ELSE runner
    /\ UNCHANGED <<pending, touchesLeft, wire, serverOpen, violation>>

\* The server reads the next message and flags a lifecycle violation.
Receive ==
    /\ wire /= << >>
    /\ LET m == Head(wire) IN
         /\ violation' =
              IF violation /= "none" THEN violation
              ELSE IF m = "didOpen" /\ serverOpen THEN "didOpen of an open document"
              ELSE IF m = "didChange" /\ ~serverOpen THEN "didChange of a closed document"
              ELSE IF m = "didClose" /\ ~serverOpen THEN "didClose of a closed document"
              ELSE "none"
         \* A didChange never opens a document: the server ignores or rejects it.
         /\ serverOpen' = IF m = "didOpen" THEN TRUE
                          ELSE IF m = "didClose" THEN FALSE
                          ELSE serverOpen
    /\ wire' = Tail(wire)
    /\ UNCHANGED <<clientOpen, pending, runner, touchesLeft, rename, closedByRename>>

Next == Touch \/ RunnerStart \/ RunnerFinish \/ RenameStart \/ CloseFinish \/ Receive

Spec == Init /\ [][Next]_vars

-----------------------------------------------------------------------------

\* The server never sees an out-of-order lifecycle message.
LifecycleOrder == violation = "none"

\* Once rename is done and everything has drained, the old path is not open
\* on the server: no phantom document for a file that was renamed away.
Quiescent == rename = "done" /\ runner = "idle" /\ ~pending /\ wire = << >>
NoPhantomAfterRename == Quiescent => ~serverOpen

\* The client's view agrees with the server's once quiescent.
ViewsAgree == (runner = "idle" /\ ~pending /\ wire = << >> /\ rename /= "closing") => clientOpen = serverOpen
=============================================================================
