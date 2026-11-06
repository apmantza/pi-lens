------------------------ MODULE DiskChangePublisher ------------------------
(***************************************************************************)
(* The disk-change publisher (#4476, #4532, #4535): the out-of-band look   *)
(* (clients/out-of-band-changes.ts), the process-wide publisher            *)
(* (clients/disk-changes.ts) and its subscribers                           *)
(* (clients/disk-change-subscribers.ts), for several roots at once.        *)
(*                                                                         *)
(* One abstract disk per root: an install stamp `dInst` (lockfiles,        *)
(* install markers, venv site-packages, server config files: a change that *)
(* cannot be enumerated) and a declaration set `dDecl` (a change the walk  *)
(* enumerates). An external change bumps one of them.                      *)
(*                                                                         *)
(* Looks (lookForOutOfBandChanges): five callers, named by `Modes`.        *)
(*   "call"    a tool_call look (runtime-tool-call.ts resyncHeadMove):     *)
(*             walks only by interval, owes nothing                        *)
(*   "result"  a bash tool_result look: owes a walk (oweDeclarationWalk)   *)
(*   "client"  a live client root's look (runtime-tool-result.ts, #4532    *)
(*             gap 7): names `since`, walk "interval", no runtime          *)
(*   "diag"    the lsp_diagnostics body (tools/lsp-diagnostics.ts):        *)
(*             walk "always", owes a walk                                  *)
(*   "head"    a HEAD-move look on a tool_result: owes a walk at the call, *)
(*             then looks later (serializeHeadLook), owing again           *)
(* A look joins the root's running flight (single-flight, coalesceTrailing)*)
(* or starts one. A joiner earns exactly one trailing pass, which runs the *)
(* FIRST caller's closure: its `since` and runtime, not the joiner's. The *)
(* epoch `since` names is captured at the call (`ep`): the trailing pass   *)
(* reuses it even after the first pass restarted the clients.              *)
(*                                                                         *)
(* A pass (lookOnce) is: P1 take the owed walk, read the record, decide    *)
(* walkDue (sync, atomic with the call or with the previous pass's end);   *)
(* Read the disk (the await); Commit the record, decide what changed and   *)
(* publish it (sync); then the publish (allocate the project sequence,     *)
(* fan out to the subscribers in order, awaited by the flight).            *)
(*                                                                         *)
(* The records and the owed-walk set are bounded FIFO maps (MAX_ROOTS):    *)
(* RecCap and OwedCap. An evicted root's next look is a first look: it     *)
(* records and publishes nothing, unless it names `since` and an install   *)
(* is fresher than the live client's epoch (installs only: a first look    *)
(* has no previous declaration map to diff).                               *)
(*                                                                         *)
(* `vInst`/`vDecl` are what the root's servers have been told: the         *)
(* baseline of the root's first-ever look (by design, #4476), moved on by  *)
(* every publish. NoLostChange is the module doc's promise that a record   *)
(* "describes the disk": a record never gets ahead of what was published.  *)
(* `ep` is another thing: the install version a "client" look read as its  *)
(* epoch when it was called. A publish moves `vInst` but never `ep`.       *)
(*                                                                         *)
(* Two sessions are two callers: they share every record, the owed set and *)
(* the flights, as the process does.                                       *)
(***************************************************************************)
EXTENDS Integers, Sequences, FiniteSets

CONSTANTS
    Roots,               \* the roots in play (strings)
    SinceRoots,          \* roots with a live client from the start: a
                         \* "client" look names its spawn epoch
    Modes,               \* look callers enabled, a subset of
                         \* {"call", "result", "client", "diag", "head"}
    Kinds,               \* external changes the schedule makes, a subset of
                         \* {"inst", "decl"}
    RecCap,              \* capacity of `records` (MAX_ROOTS = 64)
    OwedCap,             \* capacity of `owedWalks` (MAX_ROOTS = 64)
    Calls,               \* look calls the schedule makes
    Changes,             \* external disk changes the schedule makes
    AgentEdits,          \* agent edits (the authorship credit of #4131)
    Throws,              \* subscriber handler throws the schedule makes
    JoinOwesWalk,        \* TRUE as built (#4532 gap 6): a look that joins a
                         \* running flight writes its walk demand in the same
                         \* synchronous step as its join
    TrailingSeesFlightRecord, \* TRUE as built: the trailing pass compares
                         \* against the record the flight left, not the one
                         \* the flight started from
    CommitBeforePublish, \* TRUE as built (I1): lookOnce commits the record
                         \* before ensureDiskChangeSubscribers/publish
    AllocBeforeFanOut,   \* TRUE as built (I2): allocateSequence runs before
                         \* fanOut
    AwaitFanOut,         \* TRUE as built (I3): publishDiskChange awaits its
                         \* subscribers and lookOnce awaits the publish
    PublishCredits,      \* FALSE as built (I4): the publisher writes the
                         \* sequence and the change log only
    IsolateThrows,       \* TRUE as built (I5): a throwing subscriber does
                         \* not stop the others
    RecordOnce           \* TRUE as built (I5): recordDegradationOnce, one
                         \* `disk-change-subscriber-failed` per
                         \* consumer:root

NoVal == -1
NoRec == [i |-> NoVal, d |-> NoVal]
Subs == <<"cache", "lsp">>
NSubs == Len(Subs)
SubIds == {"cache", "lsp"}

VARIABLES
    dInst, dDecl,   \* the disk, per root
    extLeft,        \* external changes left
    calls,          \* look calls left
    headQ,          \* HEAD-move looks called and not yet looked
    due,            \* ghost: a walk demanded and not yet started, by root
    recs, fifo,     \* `records`: root -> record or NoRec, and its FIFO order
    owed,           \* `owedWalks`: roots in FIFO order
    fl, floc, rr,   \* per root: the flight's pc, its locals, the trailing bit
    pp,             \* per root: the publish in progress
    nPub,           \* publishes made
    projSeq,        \* the project sequence
    alloc,          \* sequences allocated, by publish
    dlv,            \* deliveries: publish, subscriber, the seq it saw
    ran,            \* handlers that ran (answered or threw), by publish
    fails,          \* disk-change-subscriber-failed records, by consumer:root
    restarts,       \* install publishes, by root and install version
    fresh,          \* the same, for passes that started as a fresh flight
    vInst, vDecl,   \* what the root's servers were told
    auth, edits,    \* authorship credits and agent edits
    throwsLeft

diskV == <<dInst, dDecl, extLeft>>
lookV == <<calls, headQ, due>>
recV == <<recs, fifo, owed>>
flightV == <<fl, floc, rr>>
pubV == <<pp, nPub, projSeq, alloc, dlv, ran, fails, restarts, fresh>>
viewV == <<vInst, vDecl>>
agentV == <<auth, edits, throwsLeft>>
vars == <<diskV, lookV, recV, flightV, pubV, viewV, agentV>>

Range(s) == {s[i] : i \in 1..Len(s)}
RemoveVal(s, v) == SelectSeq(s, LAMBDA x : x /= v)

\* BoundedFifoMap.set on a key: no reorder when present, evict the oldest
\* once the map exceeds its capacity.
OweSeq(s, v) ==
    IF v \in Range(s) THEN s
    ELSE IF Len(s) = OwedCap THEN Append(Tail(s), v) ELSE Append(s, v)

NoPub == [st |-> "none", id |-> 0, idx |-> 1, al |-> FALSE, seq |-> 0,
          enum |-> FALSE, rt |-> FALSE]

TypeOK ==
    /\ \A r \in Roots : recs[r] = NoRec \/ r \in Range(fifo)
    /\ Len(fifo) <= RecCap
    /\ Len(owed) <= OwedCap
    /\ \A r \in Roots : fl[r] \in {"idle", "Read", "Commit", "Pub", "Next"}

Init ==
    /\ dInst = [r \in Roots |-> 0]
    /\ dDecl = [r \in Roots |-> 0]
    /\ extLeft = Changes
    /\ calls = Calls
    /\ headQ = {}
    /\ due = [r \in Roots |-> FALSE]
    /\ recs = [r \in Roots |-> NoRec]
    /\ fifo = <<>>
    /\ owed = <<>>
    /\ fl = [r \in Roots |-> "idle"]
    /\ floc = [r \in Roots |-> [since |-> FALSE, ep |-> NoVal, tr |-> FALSE,
                                rt |-> FALSE, prior |-> NoRec, walk |-> FALSE, oi |-> 0,
                                od |-> 0, new |-> NoRec]]
    /\ rr = [r \in Roots |-> FALSE]
    /\ pp = [r \in Roots |-> NoPub]
    /\ nPub = 0
    /\ projSeq = 0
    /\ alloc = {}
    /\ dlv = {}
    /\ ran = {}
    /\ fails = [x \in SubIds \X Roots |-> 0]
    /\ restarts = [r \in Roots |-> [v \in 0..Changes |-> 0]]
    /\ fresh = restarts
    /\ vInst = [r \in Roots |-> IF r \in SinceRoots THEN 0 ELSE NoVal]
    /\ vDecl = [r \in Roots |-> NoVal]
    /\ auth = 0
    /\ edits = 0
    /\ throwsLeft = Throws

-----------------------------------------------------------------------------
\* The environment: edits outside pi-lens, and the agent's own.
ExtInst(r) ==
    /\ "inst" \in Kinds
    /\ extLeft > 0
    /\ extLeft' = extLeft - 1
    /\ dInst' = [dInst EXCEPT ![r] = @ + 1]
    /\ UNCHANGED <<dDecl, lookV, recV, flightV, pubV, viewV, agentV>>

ExtDecl(r) ==
    /\ "decl" \in Kinds
    /\ extLeft > 0
    /\ extLeft' = extLeft - 1
    /\ dDecl' = [dDecl EXCEPT ![r] = @ + 1]
    /\ UNCHANGED <<dInst, lookV, recV, flightV, pubV, viewV, agentV>>

\* An agent edit: the authorship credit and FileTime are the agent's alone
\* (#4131, #3865).
AgentEdit ==
    /\ edits < AgentEdits
    /\ edits' = edits + 1
    /\ auth' = auth + 1
    /\ UNCHANGED <<diskV, lookV, recV, flightV, pubV, viewV, throwsLeft>>

-----------------------------------------------------------------------------
\* P1 of lookOnce, sync: take the owed walk (owedWalks.delete), read the
\* record, decide walkDue. A pass with no demand and a record walks only
\* when the interval has passed, which the model leaves open.
Begin(r, sinceB, epB, trB, rtB, owedIn, dueIn, recIn) ==
    \E w \in (IF r \in Range(owedIn) \/ recIn = NoRec THEN {TRUE} ELSE BOOLEAN) :
        /\ owed' = RemoveVal(owedIn, r)
        /\ due' = [dueIn EXCEPT ![r] = @ /\ ~w]
        /\ fl' = [fl EXCEPT ![r] = "Read"]
        /\ floc' = [floc EXCEPT ![r] = [since |-> sinceB, ep |-> epB, tr |-> trB,
                                        rt |-> rtB,
                                        prior |-> recIn, walk |-> w,
                                        oi |-> 0, od |-> 0, new |-> NoRec]]

\* lookForOutOfBandChanges: oweDeclarationWalk, then looks.run(key, ...).
\* A mid-flight call shares the flight and earns one trailing pass.
Dispatch(r, sinceB, rtB, oweB) ==
    LET dueIn == IF oweB THEN [due EXCEPT ![r] = TRUE] ELSE due IN
    IF fl[r] = "idle"
    THEN /\ Begin(r, sinceB, IF sinceB THEN vInst[r] ELSE NoVal, FALSE, rtB,
                  IF oweB THEN OweSeq(owed, r) ELSE owed, dueIn, recs[r])
         /\ UNCHANGED <<rr, recs, fifo>>
    ELSE /\ rr' = [rr EXCEPT ![r] = TRUE]
         /\ owed' = IF oweB /\ JoinOwesWalk THEN OweSeq(owed, r) ELSE owed
         /\ due' = dueIn
         /\ UNCHANGED <<fl, floc, recs, fifo>>

Owes(mode) == mode \in {"result", "diag", "head"}

LookCall(r, mode) ==
    /\ calls > 0
    /\ mode \in Modes
    /\ mode = "client" => r \in SinceRoots
    /\ calls' = calls - 1
    /\ IF mode = "head"
       THEN \* resyncHeadMove: the demand now, the look after the queue
            /\ owed' = OweSeq(owed, r)
            /\ due' = [due EXCEPT ![r] = TRUE]
            /\ headQ' = headQ \cup {r}
            /\ UNCHANGED <<flightV, recs, fifo>>
       ELSE /\ Dispatch(r, mode = "client", mode /= "client", Owes(mode))
            /\ UNCHANGED headQ
    /\ UNCHANGED <<diskV, pubV, viewV, agentV>>

HeadLook(r) ==
    /\ r \in headQ
    /\ headQ' = headQ \ {r}
    /\ Dispatch(r, FALSE, TRUE, TRUE)
    /\ UNCHANGED <<diskV, calls, pubV, viewV, agentV>>

\* The await of readInstallStamp and walkDeclarations: the disk as read.
Read(r) ==
    /\ fl[r] = "Read"
    /\ fl' = [fl EXCEPT ![r] = "Commit"]
    /\ floc' = [floc EXCEPT ![r].oi = dInst[r], ![r].od = dDecl[r]]
    /\ UNCHANGED <<diskV, lookV, recV, rr, pubV, viewV, agentV>>

\* records.set: no reorder of a present key, evict the oldest past the cap.
CommitRec(r, rec) ==
    IF r \in Range(fifo)
    THEN /\ recs' = [recs EXCEPT ![r] = rec]
         /\ fifo' = fifo
    ELSE IF Len(fifo) = RecCap
         THEN /\ recs' = [recs EXCEPT ![Head(fifo)] = NoRec, ![r] = rec]
              /\ fifo' = Append(Tail(fifo), r)
         ELSE /\ recs' = [recs EXCEPT ![r] = rec]
              /\ fifo' = Append(fifo, r)

\* Sync after the await: commit the record (I1), diff, publish. A first look
\* (no record) publishes an install fresher than the epoch the CALLER named
\* (`firstLookSawInstall(install, options.since)`), `L.ep`, not what the
\* servers hold now (`vInst`): a trailing pass reuses the first caller's epoch.
Commit(r) ==
    LET L == floc[r]
        prior == L.prior
        installed == IF prior = NoRec
                        THEN L.since /\ L.oi > L.ep
                        ELSE L.oi /= prior.i
        dchg == L.walk /\ prior /= NoRec /\ L.od /= prior.d
        newRec == [i |-> L.oi,
                   d |-> IF L.walk THEN L.od ELSE prior.d]
        publishes == installed \/ dchg
    IN
    /\ fl[r] = "Commit"
    /\ publishes => pp[r].st \in {"none", "done"}
    /\ IF CommitBeforePublish \/ ~publishes
       THEN CommitRec(r, newRec)
       ELSE UNCHANGED <<recs, fifo>>
    /\ floc' = [floc EXCEPT ![r].new = newRec]
    \* what the servers were told: the first-ever look of a root records a
    \* baseline and tells nobody unless it names `since` (#4476, #4532); what
    \* it records is what the servers are taken to hold. Then every publish.
    /\ vInst' = [vInst EXCEPT ![r] = IF installed \/ vDecl[r] = NoVal
                                    THEN L.oi ELSE @]
    /\ vDecl' = [vDecl EXCEPT ![r] = IF dchg \/ @ = NoVal THEN L.od ELSE @]
    /\ restarts' = IF installed
                      THEN [restarts EXCEPT ![r][L.oi] = @ + 1]
                      ELSE restarts
    /\ fresh' = IF installed /\ ~L.tr
                  THEN [fresh EXCEPT ![r][L.oi] = @ + 1]
                  ELSE fresh
    /\ IF publishes
       THEN /\ nPub' = nPub + 1
            /\ pp' = [pp EXCEPT ![r] = [st |-> "Fan", id |-> nPub + 1,
                                        idx |-> 1, al |-> FALSE, seq |-> 0,
                                        enum |-> ~installed, rt |-> L.rt]]
            /\ fl' = [fl EXCEPT ![r] = "Pub"]
       ELSE /\ fl' = [fl EXCEPT ![r] = "Next"]
            /\ UNCHANGED <<pp, nPub>>
    /\ UNCHANGED <<diskV, lookV, owed, rr, projSeq, alloc, dlv, ran, fails,
                   agentV>>

\* allocateSequence: only an enumerable population, only with a runtime.
Alloc(r) ==
    LET p == pp[r]
        n == IF p.enum /\ p.rt THEN projSeq + 1 ELSE 0
    IN
    /\ p.st = "Fan"
    /\ ~p.al
    /\ (AllocBeforeFanOut \/ p.idx = 2)
    /\ pp' = [pp EXCEPT ![r].al = TRUE, ![r].seq = n]
    /\ projSeq' = IF n > 0 THEN n ELSE projSeq
    /\ alloc' = alloc \cup {[id |-> p.id, seq |-> n]}
    /\ auth' = IF PublishCredits THEN auth + 1 ELSE auth
    /\ UNCHANGED <<diskV, lookV, recV, flightV, viewV, nPub, dlv, ran, fails,
                   restarts, fresh, edits, throwsLeft>>

\* fanOut: one registered consumer at a time, in registration order.
FanOk(r) ==
    LET p == pp[r] IN
    /\ p.st = "Fan"
    /\ p.idx <= NSubs
    /\ p.al \/ (~AllocBeforeFanOut /\ p.idx = 1)
    /\ dlv' = dlv \cup {[id |-> p.id, sub |-> Subs[p.idx],
                         seq |-> IF p.al THEN p.seq ELSE 0]}
    /\ ran' = ran \cup {[id |-> p.id, sub |-> Subs[p.idx]]}
    /\ pp' = [pp EXCEPT ![r].idx = p.idx + 1,
                        ![r].st = IF p.idx = NSubs THEN "done" ELSE "Fan"]
    /\ UNCHANGED <<diskV, lookV, recV, flightV, viewV, nPub, projSeq, alloc,
                   fails, restarts, fresh, agentV>>

FanThrow(r) ==
    LET p == pp[r]
        sub == Subs[p.idx]
    IN
    /\ p.st = "Fan"
    /\ p.idx <= NSubs
    /\ p.al \/ (~AllocBeforeFanOut /\ p.idx = 1)
    /\ throwsLeft > 0
    /\ throwsLeft' = throwsLeft - 1
    /\ ran' = ran \cup {[id |-> p.id, sub |-> sub]}
    /\ fails' = [fails EXCEPT ![<<sub, r>>] = IF RecordOnce THEN 1 ELSE @ + 1]
    /\ pp' = [pp EXCEPT ![r].idx = p.idx + 1,
                        ![r].st = IF p.idx = NSubs \/ ~IsolateThrows
                                     THEN "done" ELSE "Fan"]
    /\ UNCHANGED <<diskV, lookV, recV, flightV, viewV, nPub, projSeq, alloc,
                   dlv, restarts, fresh, auth, edits>>

\* lookOnce returns once publishDiskChange resolved, which is after the fan-out.
\* Not awaited, the flight moves on while the fan-out is still running.
PubDone(r) ==
    /\ fl[r] = "Pub"
    /\ IF AwaitFanOut THEN pp[r].st = "done" ELSE TRUE
    /\ fl' = [fl EXCEPT ![r] = "Next"]
    /\ UNCHANGED <<diskV, lookV, recV, floc, rr, pubV, viewV, agentV>>

\* The chain loop: one trailing pass for the callers that joined, else the
\* flight settles and releases its key.
Next(r) ==
    /\ fl[r] = "Next"
    /\ IF CommitBeforePublish
       THEN UNCHANGED <<recs, fifo>>
       ELSE CommitRec(r, floc[r].new)
    /\ IF rr[r]
       THEN /\ rr' = [rr EXCEPT ![r] = FALSE]
            /\ \* the trailing pass runs the first caller's closure: its
               \* `since` and its runtime, not the joiner's
               Begin(r, floc[r].since, floc[r].ep, TRUE, floc[r].rt, owed, due,
                     IF ~TrailingSeesFlightRecord THEN floc[r].prior
                     ELSE IF CommitBeforePublish THEN recs[r]
                     ELSE floc[r].new)
       ELSE /\ fl' = [fl EXCEPT ![r] = "idle"]
            /\ UNCHANGED <<rr, owed, floc, due>>
    /\ UNCHANGED <<diskV, calls, headQ, pubV, viewV, agentV>>

-----------------------------------------------------------------------------
Step ==
    \/ \E r \in Roots : ExtInst(r) \/ ExtDecl(r)
    \/ AgentEdit
    \/ \E r \in Roots, m \in Modes : LookCall(r, m)
    \/ \E r \in Roots : HeadLook(r) \/ Read(r) \/ Commit(r) \/ Alloc(r)
                        \/ FanOk(r) \/ FanThrow(r) \/ PubDone(r) \/ Next(r)

Spec == Init /\ [][Step]_vars

-----------------------------------------------------------------------------
\* I1 (disk-changes.ts "the detector commits its own per-root record BEFORE
\* publishing"; out-of-band-changes.ts lookOnce): while a publish is being
\* allocated or fanned out, the root's record already holds the pass's view
\* of the disk (or was evicted since).
I1CommitBeforePublish ==
    \A r \in Roots :
        pp[r].st = "Fan" =>
            (recs[r] = NoRec \/ recs[r] = floc[r].new)

\* I2 ("the sequence is allocated BEFORE the fan-out, so one seq and one at
\* describe the same event for every consumer"): every delivery saw the
\* sequence its publish allocated, and none came before the allocation.
I2SeqBeforeFanOut ==
    \A d \in dlv : [id |-> d.id, seq |-> d.seq] \in alloc

\* I3 ("the caller owns the await: the publisher awaits its subscribers"):
\* a flight that has settled has no fan-out still running.
I3AwaitedFanOut ==
    \A r \in Roots : fl[r] = "idle" => pp[r].st \in {"none", "done"}

\* I4 ("the publisher writes the sequence and the change log only ...
\* an incoming change never credits authorship"): the authorship credit is
\* the agent's edits, whatever was published.
I4NoAuthorship == auth = edits

\* I5 ("a throwing subscriber is isolated and recorded once per consumer per
\* root"): every consumer of a finished fan-out ran, and a consumer:root
\* has at most one record.
I5Isolated ==
    \A r \in Roots :
        pp[r].st = "done" =>
            \A i \in 1..NSubs : [id |-> pp[r].id, sub |-> Subs[i]] \in ran
I5RecordedOnce == \A x \in SubIds \X Roots : fails[x] <= 1

\* Two sessions on one root share the record "so one install restarts once".
OneRestartPerInstall ==
    \A r \in Roots, v \in 0..Changes : restarts[r][v] <= 1

\* The same promise for passes that started as a fresh flight, a trailing pass
\* left out. A config under eviction checks this one, so it still proves the
\* first-look epoch filter never passes an install the client already read
\* (EvictedInstallTrailing owns the trailing pass, which does).
OneFreshRestartPerInstall ==
    \A r \in Roots, v \in 0..Changes : fresh[r][v] <= 1

\* Every look of the root names the live client's spawn epoch, so an evicted
\* record's first look still publishes an install fresher than it.
NextLookNamesEpoch(r) == r \in SinceRoots /\ Modes = {"client"}

\* The record "describes the disk" (out-of-band-changes.ts module doc): when
\* the root's servers hold a stale view of a stamp, the record still shows the
\* difference, so a later look publishes it. B2a: the FIFO evicts the record,
\* the next look is a first look, and the change is recorded as a baseline.
NoLostChange ==
    \A r \in Roots :
        /\ (vDecl[r] /= NoVal /\ dInst[r] /= vInst[r]) =>
              \/ recs[r] /= NoRec /\ recs[r].i /= dInst[r]
              \/ recs[r] = NoRec /\ NextLookNamesEpoch(r)
        /\ (vDecl[r] /= NoVal /\ dDecl[r] /= vDecl[r]) =>
              (recs[r] /= NoRec /\ recs[r].d /= dDecl[r])

\* #4532 gap 6 ("a joined look gets the walk it demands"): once a root's
\* flight has settled, no caller's walk demand is still unserved by a pass
\* that started after it. An evicted demand "only defers the change to the
\* next walk" (the owedWalks comment): the invariant is violated by it.
DemandServed ==
    \A r \in Roots : (fl[r] = "idle" /\ r \notin headQ) => ~due[r]

\* Sanity: a publish can be delivered at all (checked as a violated
\* "invariant").
NeverDelivers == dlv = {}
=============================================================================
