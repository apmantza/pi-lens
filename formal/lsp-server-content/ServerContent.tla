--------------------------- MODULE ServerContent ---------------------------
(***************************************************************************)
(* One file N: the content a language server holds for it versus the      *)
(* bytes on disk, across concurrent writers and readers.                   *)
(*                                                                         *)
(* Actors:                                                                 *)
(*  - writers w1, w2: an agent write of N (disk write, new mtime), then    *)
(*    that edit's pipeline touch (clients/pipeline.ts ~1349 readFileSync,  *)
(*    ~1102 touchFile source "lsp_sync", scope "primary"). Two same-turn   *)
(*    pipelines for one file may run concurrently (write-ordering-guard.ts *)
(*    ~6-13);                                                              *)
(*  - the cascade neighbour reader cas (dispatch/integration.ts ~1972      *)
(*    readFile, then awaits, then touchFile ~2009 / ~2099, scope primary); *)
(*  - LSPService.touchFile (lsp/index.ts): startedAt anchored at its start *)
(*    (~4640), shouldSkipNotify per server (~4846, 1500 ms debounce on a  *)
(*    length+first48+last48 fingerprint, ~1908), then notify.open, then    *)
(*    after the write lands markTouched (~5173) and                        *)
(*    recordFullyCoveredSync(startedAt) (~5199). A fully skipped touch     *)
(*    records nothing;                                                     *)
(*  - the per-path notify queue (lsp/client.ts enqueueDocumentNotify       *)
(*    ~4199): an unstarted entry is REPLACED by the last enqueued one (its *)
(*    waiters ride along); the runner sends one entry at a time. The check *)
(*    and the send are one step (vscode-jsonrpc orders at send time);      *)
(*  - the drift sweep (lsp/document-drift.ts runSweep ~306): stat, a       *)
(*    candidate when size differs or floor(mtime) > syncedAt; read; equal  *)
(*    fingerprint -> re-stamp only ("unchanged"), else resync through      *)
(*    touchFile (source drift_resync, scope "all", its own debounce key)   *)
(*    and stamp settledStamp(now, observedMtime) if the record advanced.   *)
(*                                                                         *)
(* Every await is a step boundary. Time is a logical clock advanced on     *)
(* each stamped event, so no two stamps tie (the real floor() tie widens   *)
(* the blind window by 1 ms; not modelled).                                *)
(***************************************************************************)
EXTENDS Naturals

CONSTANTS
    Writes,       \* 1 or 2 agent writes of N (w1 writes "B", w2 writes "C")
    Cascade,      \* TRUE: a cascade neighbour reader touches N
    EqualLength,  \* TRUE: every version of N has the same byte length
    LossyFp,      \* TRUE: versions differ only in the middle of a >96-char file,
                  \* so the length+first48+last48 fingerprint cannot tell them apart
    Debounce,     \* TRUE: shouldSkipNotify is active (TOUCH_DEBOUNCE_MS > 0)
    RecentA,      \* TRUE: a touch of the initial content landed within the debounce window
    MidSweeps,    \* sweep passes allowed while other actors are still active
    SweepKey,     \* "both" (the code), "size", "mtime": which half of the drift key is compared
    PriorInFlight, \* TRUE: an earlier notify of N (content A) is still being written when the model starts
    FifoLanding,  \* TRUE: co-waiters of one entry finish in enqueue order (JS microtask FIFO)
    FixCoalesce,  \* candidate fix, part 1: a queued entry is only replaced by one read no earlier
    FixDrop       \* candidate fix, part 2: the runner drops an entry read before the content last sent

Writers == {"w1", "w2"}
Procs == {"w1", "w2", "cas", "res"}
WriteOf == [w \in Writers |-> IF w = "w1" THEN "B" ELSE "C"]
Contents == {"A", "B", "C"}
Size(c) == IF EqualLength THEN 1 ELSE CASE c = "A" -> 1 [] c = "B" -> 2 [] c = "C" -> 3
Fp(c) == IF LossyFp THEN Size(c) ELSE c
Max(a, b) == IF a > b THEN a ELSE b

NoEntry == [waiters |-> {}, content |-> "none", seq |-> 0]

VARIABLES
    clock,
    disk, mtime,          \* bytes on disk and their mtime
    server,               \* content the server holds (what was last sent)
    lastSentSeq,          \* read stamp of the content last sent
    staleSend,            \* a send replaced content read later than the content sent
    pc, content, readAt, startAt, enqAt,
    pending, running,     \* the notify queue: unstarted entry, entry in flight
    record,               \* drift record: [size, fp, at]
    recent,               \* debounce entry for scope primary: [fp, fresh]
    sweep, sweepMtime, sweepContent, sweepsLeft, clean

vars == <<clock, disk, mtime, server, lastSentSeq, staleSend, pc, content, readAt,
          startAt, enqAt, pending, running, record, recent, sweep, sweepMtime,
          sweepContent, sweepsLeft, clean>>

Init ==
    /\ clock = 0
    /\ disk = "A" /\ mtime = 0
    /\ server = "A" /\ lastSentSeq = 0 /\ staleSend = FALSE
    /\ pc = [p \in Procs |->
               CASE p = "w1" -> "write"
                 [] p = "w2" -> (IF Writes = 2 THEN "write" ELSE "off")
                 [] p = "cas" -> (IF Cascade THEN "read" ELSE "off")
                 [] OTHER -> "off"]
    /\ content = [p \in Procs |-> "none"]
    /\ readAt = [p \in Procs |-> 0]
    /\ startAt = [p \in Procs |-> 0]
    /\ enqAt = [p \in Procs |-> 0]
    /\ pending = NoEntry
    /\ running = IF PriorInFlight THEN [waiters |-> {}, content |-> "A", seq |-> 0] ELSE NoEntry
    /\ record = [size |-> Size("A"), fp |-> Fp("A"), at |-> 0]
    /\ recent = [fp |-> Fp("A"), fresh |-> RecentA]
    /\ sweep = "idle" /\ sweepMtime = 0 /\ sweepContent = "none"
    /\ sweepsLeft = MidSweeps /\ clean = FALSE

Tick == clock' = clock + 1

\* The agent's write tool lands its bytes.
Write(p) ==
    /\ pc[p] = "write"
    /\ Tick /\ disk' = WriteOf[p] /\ mtime' = clock + 1
    /\ pc' = [pc EXCEPT ![p] = "read"]
    /\ UNCHANGED <<enqAt, server, lastSentSeq, staleSend, content, readAt, startAt, pending,
                   running, record, recent, sweep, sweepMtime, sweepContent, sweepsLeft, clean>>

\* Pipeline readFileSync / cascade `await readFile`: capture disk.
Read(p) ==
    /\ pc[p] = "read" /\ p # "res"
    /\ Tick
    /\ content' = [content EXCEPT ![p] = disk]
    /\ readAt' = [readAt EXCEPT ![p] = clock + 1]
    /\ pc' = [pc EXCEPT ![p] = "start"]
    /\ UNCHANGED <<enqAt, disk, mtime, server, lastSentSeq, staleSend, startAt, pending, running,
                   record, recent, sweep, sweepMtime, sweepContent, sweepsLeft, clean>>

\* touchFile begins: startedAt (the drift record's syncedAt) is taken here.
Start(p) ==
    /\ pc[p] = "start"
    /\ Tick
    /\ startAt' = [startAt EXCEPT ![p] = clock + 1]
    /\ pc' = [pc EXCEPT ![p] = "check"]
    /\ UNCHANGED <<enqAt, disk, mtime, server, lastSentSeq, staleSend, content, readAt, pending,
                   running, record, recent, sweep, sweepMtime, sweepContent, sweepsLeft, clean>>

\* shouldSkipTouch / notifySkippedServerIds: a debounce hit sends and records nothing.
\* The drift resync uses scope "all", a different debounce key: never skipped here.
Check(p) ==
    /\ pc[p] = "check"
    /\ pc' = [pc EXCEPT ![p] =
                IF Debounce /\ p # "res" /\ recent.fresh /\ recent.fp = Fp(content[p])
                  THEN "done" ELSE "enqueue"]
    /\ UNCHANGED <<enqAt, clock, disk, mtime, server, lastSentSeq, staleSend, content, readAt,
                   startAt, pending, running, record, recent, sweep, sweepMtime,
                   sweepContent, sweepsLeft, clean>>

\* notify.open -> enqueueDocumentNotify: last enqueued wins, waiters carried.
\* The first entry of an idle queue starts on the next microtask, before any
\* other actor's I/O continuation can enqueue: modelled as RunStart having to
\* fire first (no Enqueue while an entry is pending on an idle runner).
Enqueue(p) ==
    /\ pc[p] = "enqueue"
    /\ ~(pending # NoEntry /\ running = NoEntry)
    /\ Tick
    /\ enqAt' = [enqAt EXCEPT ![p] = clock + 1]
    /\ LET keepOld == FixCoalesce /\ pending # NoEntry /\ pending.seq > readAt[p]
       IN pending' = [waiters |-> pending.waiters \cup {p},
                      content |-> IF keepOld THEN pending.content ELSE content[p],
                      seq     |-> IF keepOld THEN pending.seq ELSE readAt[p]]
    /\ pc' = [pc EXCEPT ![p] = "wait"]
    /\ UNCHANGED <<disk, mtime, server, lastSentSeq, staleSend, content, readAt,
                   startAt, running, record, recent, sweep, sweepMtime, sweepContent,
                   sweepsLeft, clean>>

\* Take the unstarted entry and send it: check and send are one tick.
TakeAndSend ==
    /\ running' = pending /\ pending' = NoEntry
    /\ IF FixDrop /\ pending.seq < lastSentSeq
         THEN UNCHANGED <<server, lastSentSeq, staleSend>>
         ELSE /\ server' = pending.content
              /\ lastSentSeq' = pending.seq
              /\ staleSend' = (staleSend \/ (pending.seq < lastSentSeq /\ pending.content # server))

\* The runner's first iteration (microtask after the first enqueue).
RunStart ==
    /\ running = NoEntry /\ pending # NoEntry
    /\ TakeAndSend
    /\ UNCHANGED <<clock, disk, mtime, pc, content, readAt, startAt, enqAt, record, recent,
                   sweep, sweepMtime, sweepContent, sweepsLeft, clean>>

\* The in-flight send resolves: its waiters are resolved, and the runner's
\* for(;;) loop takes the next unstarted entry in the same tick (client.ts ~4232).
RunFinish ==
    /\ running # NoEntry
    /\ pc' = [p \in Procs |-> IF p \in running.waiters THEN "landed" ELSE pc[p]]
    /\ IF pending # NoEntry
         THEN TakeAndSend
         ELSE /\ running' = NoEntry
              /\ UNCHANGED <<pending, server, lastSentSeq, staleSend>>
    /\ UNCHANGED <<clock, disk, mtime, content, readAt, startAt, enqAt, record, recent,
                   sweep, sweepMtime, sweepContent, sweepsLeft, clean>>

\* touchFile after its write landed: markTouched (primary scope) and the drift
\* record stamped with its OWN content at its START time.
Finish(p) ==
    /\ pc[p] = "landed"
    /\ FifoLanding => \A q \in Procs : pc[q] = "landed" => enqAt[q] >= enqAt[p]
    /\ record' = [size |-> Size(content[p]), fp |-> Fp(content[p]), at |-> startAt[p]]
    /\ recent' = IF p = "res" THEN recent ELSE [fp |-> Fp(content[p]), fresh |-> TRUE]
    /\ pc' = [pc EXCEPT ![p] = "done"]
    /\ UNCHANGED <<enqAt, clock, disk, mtime, server, lastSentSeq, staleSend, content, readAt,
                   startAt, pending, running, sweep, sweepMtime, sweepContent,
                   sweepsLeft, clean>>

\* TOUCH_DEBOUNCE_MS elapses.
Expire ==
    /\ recent.fresh
    /\ recent' = [recent EXCEPT !.fresh = FALSE]
    /\ UNCHANGED <<enqAt, clock, disk, mtime, server, lastSentSeq, staleSend, pc, content, readAt,
                   startAt, pending, running, record, sweep, sweepMtime, sweepContent,
                   sweepsLeft, clean>>

OthersDone ==
    /\ \A p \in {"w1", "w2", "cas"} : pc[p] \in {"off", "done"}
    /\ pending = NoEntry /\ running = NoEntry

\* A sweep pass: stat and compare against the record.
SweepStat ==
    /\ sweep = "idle"
    /\ pc["res"] \in {"off", "done"}
    /\ sweepsLeft > 0 \/ OthersDone
    /\ ~(OthersDone /\ clean)
    /\ LET sizeMoved == SweepKey # "mtime" /\ Size(disk) # record.size
           mtimeMoved == SweepKey # "size" /\ mtime > record.at
       IN IF sizeMoved \/ mtimeMoved
            THEN /\ sweep' = "read" /\ sweepMtime' = mtime /\ clean' = FALSE
            ELSE /\ clean' = OthersDone /\ UNCHANGED <<sweep, sweepMtime>>
    /\ sweepsLeft' = IF OthersDone THEN sweepsLeft ELSE sweepsLeft - 1
    /\ UNCHANGED <<enqAt, clock, disk, mtime, server, lastSentSeq, staleSend, pc, content, readAt,
                   startAt, pending, running, record, recent, sweepContent>>

\* The candidate is read; unchanged fingerprint re-stamps, otherwise resync.
SweepRead ==
    /\ sweep = "read"
    /\ Tick
    /\ IF Fp(disk) = record.fp
         THEN /\ record' = [size |-> Size(disk), fp |-> Fp(disk), at |-> Max(clock + 1, sweepMtime)]
              /\ sweep' = "idle"
              /\ UNCHANGED <<pc, content, readAt, sweepContent>>
         ELSE /\ sweep' = "resync"
              /\ sweepContent' = disk
              /\ content' = [content EXCEPT !["res"] = disk]
              /\ readAt' = [readAt EXCEPT !["res"] = clock + 1]
              /\ pc' = [pc EXCEPT !["res"] = "start"]
              /\ UNCHANGED record
    /\ UNCHANGED <<enqAt, disk, mtime, server, lastSentSeq, staleSend, startAt, pending, running,
                   recent, sweepMtime, sweepsLeft, clean>>

\* After the resync touch: stamp authoritatively if the record advanced to it.
SweepSettle ==
    /\ sweep = "resync" /\ pc["res"] = "done"
    /\ Tick
    /\ record' = IF record.fp = Fp(sweepContent)
                   THEN [size |-> Size(sweepContent), fp |-> Fp(sweepContent),
                         at |-> Max(clock + 1, sweepMtime)]
                   ELSE record
    /\ sweep' = "idle"
    /\ UNCHANGED <<enqAt, disk, mtime, server, lastSentSeq, staleSend, pc, content, readAt,
                   startAt, pending, running, recent, sweepMtime, sweepContent,
                   sweepsLeft, clean>>

Next ==
    \/ \E p \in Writers : Write(p)
    \/ \E p \in Procs : Read(p) \/ Start(p) \/ Check(p) \/ Enqueue(p) \/ Finish(p)
    \/ RunStart \/ RunFinish \/ Expire
    \/ SweepStat \/ SweepRead \/ SweepSettle

Spec == Init /\ [][Next]_vars

-----------------------------------------------------------------------------

\* Every actor is done, the queue is empty, and a full sweep pass after that
\* found nothing to do.
Quiescent == OthersDone /\ sweep = "idle" /\ pc["res"] \in {"off", "done"} /\ clean

\* Once quiescent, the server holds exactly what is on disk.
ServerMatchesDisk == Quiescent => server = disk

\* Per-send: the runner never replaces content with DIFFERENT content read earlier.
SendsMonotone == ~staleSend
=============================================================================
