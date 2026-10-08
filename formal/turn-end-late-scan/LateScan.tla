------------------------------ MODULE LateScan ------------------------------
(***************************************************************************)
(* The turn_end dead-code lane's late scan: a vulture scan that missed the *)
(* turn_end budget is parked, settles off-hook, and is carried to a later  *)
(* turn_end (clients/runtime-turn.ts, #4117 round 2). Source lines are at  *)
(* master b73d4ceaf; the symbol next to each line is the stable anchor.    *)
(*                                                                         *)
(* One lane = one (client, root). State:                                   *)
(*  - row     the baseline row `dead-code-<id>` in the cache (kind and the *)
(*            edits its scan had seen: `snap`);                            *)
(*  - scan    the client's single-flight vulture process                   *)
(*            (dead-code-client.ts:458-471): a second analyze() while one  *)
(*            runs JOINS it and gets the same, older, result;              *)
(*  - w       the turn_end handler that is awaiting the scan inside        *)
(*            bounded() (runtime-turn.ts:2727-2736);                       *)
(*  - en/slot the parked entries; `slot` is the map `lateDeadCodeScansOf`  *)
(*            (runtime-turn.ts:540-548), one cell per session scope.       *)
(*                                                                         *)
(* Actions, each tied to its line:                                         *)
(*  Edit          the turn's modified files (modifiedFiles, :2554);        *)
(*  TurnEndTake   a settled entry is taken, its delta delivered, its carry *)
(*                joins this turn's scan files (:2677-2686, :2693);        *)
(*  TurnEndCarry  an in-flight entry takes this turn's files as carry and  *)
(*                no scan starts (:2688-2692);                             *)
(*  TurnEndStart  InlineScan: no entry, so start the scan and await it     *)
(*                (:2693-2727);                                            *)
(*  InlineFinish  Await finished inside the budget: the inline writer      *)
(*                compares a failure with the row (Poison) and writes      *)
(*                (:2755-2786); a joined await is not finished here (Join);*)
(*  Abandon       Park: bounded() gave up, or the await joined a running   *)
(*                scan (#4154); the entry is created                       *)
(*                (:2737-2753, runtime-turn.ts:608-629);                   *)
(*  TurnEndSkip   the back-off: the root is skipped (:2703-2718);           *)
(*  ScanComplete  the vulture process ends: ok, fail or threw; the client  *)
(*                stamps a failure here (dead-code-client.ts:461);         *)
(*  EntrySettle   Settle (session current | ended) and Drop: the .then     *)
(*                handler (:630-663, dropLateDeadCodeScan :587-600);       *)
(*  SessionReplace /new, fork, reload, quit: resetForSession retires the   *)
(*                scope (runtime-coordinator.ts:652-654);                  *)
(*  ForeignWrite  a writer outside the lane stores a good row (the         *)
(*                lens_diagnostics fresh fetch, fresh-fetch.ts:858-870);   *)
(*  ForeignStamp  a scan outside the lane (the fresh fetch, session_start) *)
(*                dies to a timeout and stamps the shared client           *)
(*                (fresh-fetch.ts:858, runtime-session.ts:1522);           *)
(*  Expire, ExpireBadRow  the 30 minute mark and the cache age run out;    *)
(*  Idle          stutter when nothing is pending: with CHECK_DEADLOCK on, *)
(*                work with no enabled action is a lane that cannot        *)
(*                progress (bounded form of "a settled result is taken"). *)
(*                                                                         *)
(* Invariants:                                                             *)
(*  SingleWriter    one scan result is written to the row once: the inline *)
(*                  writer XOR the settle handler;                         *)
(*  NoCrossSession  an ended session's settle writes nothing and no entry  *)
(*                  is delivered in another session;                       *)
(*  NoPoison        a failed scan never replaces a good row (#925);        *)
(*  NoLostEdit      a file edited while the scan runs is in the carry of a *)
(*                  live entry until a started scan covers it;             *)
(*  NoSecondStart   no scan starts while an entry is in flight;            *)
(*  NoDoubleDelivery  a scan's result is delivered at most once;           *)
(*  NoDeliverFailed  a failed scan result is never delivered (#4120 L9);   *)
(*  NoOrphanScan    a running scan always has a consumer (round 1 had none);*)
(*  NoLostRow       a successful scan a live handler saw is in the row;    *)
(*  NoRespawnWhileStamped  a scan that died to a timeout or kill is not    *)
(*                  respawned until the mark expires or a scan succeeds;   *)
(*  NoStaleCover    a file is never left with only a result that predates  *)
(*                  its edit (#4154 J1);                                   *)
(*  NoLostEditStrict: a documented degradation (V2), see the README.       *)
(*                                                                         *)
(* Abstractions (README "What the model cannot see"): the file set is one  *)
(* id per edit; Edit, SessionReplace and ForeignWrite do not occur while a *)
(* handler awaits (the agent is stopped for the budget) or between a      *)
(* scan's end and its handlers (Quiet); ownership, the delta text, the     *)
(* knip lane and a concurrent secondary session (fenced in the code by     *)
(* #4154; lane M4) are not modelled.                                       *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS
    Edits,         \* the files an agent can edit
    MaxSess,       \* sessions 1..MaxSess
    MaxScan,       \* bound on vulture processes started
    MaxEnt,        \* bound on entries created
    Settle,        \* "checked"   the shipped isCurrentSession guard (:632)
                   \* "unchecked" mutant: a settle after the session ended writes
    SettlePoison,  \* "guarded"   the settle handler asks wouldPoisonCache (:639)
                   \* "unguarded" mutant: it writes a failure over a good row
    Poison,        \* "current"  shipped (#4154 V1): a failure is compared with the
                   \*            row as it is when the scan settled
                   \* "start"    pre-#4154: both writers compare with the row read
                   \*            when the scan STARTED (VERIFY_4120 V1)
    Late,          \* "keep"          round 2: the late result is written and parked
                   \* "dropAtPark"   round 1: bounded() gave up and nothing keeps the scan
                   \* "dropAtSettle" mutant: the handler sees the result and throws it away
                   \* "keepFailed"   mutant (#4120 L9): a failed result is kept as a
                   \*                deliverable entry (the drop at :650-657 gone)
                   \* "neverTake"    mutant (#4120 L1): a settled entry is never taken
                   \*                (the take at :2677 gone)
    InFlight,      \* "carry" shipped: an in-flight entry takes the turn's files
                   \* "scan"  mutant: a turn_end starts its own scan beside it
    CarryRec,      \* "on" shipped (:2689); "off" mutant: carry not recorded
    EntryScope,    \* "session" shipped: the entry lives on the scope's cell
                   \* "module"  mutant: round 1's module-level map
    Foreign,       \* "on": a writer outside the lane may store a good row once
    TakeBackoff,   \* "on" shipped: the back-off at :2703-2718 also follows a take
                   \* "off" mutant: a take starts its scan on a stamped root
    Backoff,       \* "both" shipped: a root with a recent hard failure is skipped by
                   \*          the failed row (:2703) and by the client's mark (:2707)
                   \* "row"  pre-#4117: only the failed row is read
    StampAt,       \* "settle" shipped: the client stamps where the scan settles
                   \*          (dead-code-client.ts:461)
                   \* "turn"  pre-#4117: only a scan that settled inside the turn
                   \*          left a mark
    Join           \* "carry" shipped (#4154 J1): a scan that was already running
                   \*         when the lane asked (joinedEarlierScan) is never finished
                   \*         inline; it is parked, and when it is taken its files join
                   \*         the next scan
                   \* "trust" pre-#4154: the joined result is the answer for the files

VARIABLES
    cur,          \* the current session
    made,         \* every edit so far
    turnEdits,    \* edits since the last turn_end that reached the lane
    row,          \* [kind |-> none | good | bad, snap |-> edits it reflects]
    scRun,        \* a vulture process is running
    scId,         \* the id of the latest process started
    scSnap,       \* the edits that existed when it started
    w,            \* the awaiting turn_end handler, or NoW
    en,           \* eid -> entry
    slot,         \* map cell -> eid or 0
    nextE,        \* next free eid
    owed,         \* edits promised to the next started scan
    rowOwed,      \* the snap of the last ok result a live handler saw
    lostCounted,  \* carried edits lost with a counted drop
    wrote,        \* process ids already written to the row
    fgn,          \* the foreign write happened
    fst,          \* the foreign stamp happened
    poisoned,     \* a failure replaced a good row
    crossWrite,   \* a settle wrote for an ended session
    crossDeliver, \* an entry was delivered in another session
    dupWrite,     \* one process result was written twice
    secondStart,  \* a scan started beside an in-flight entry
    staleCover,   \* files were covered by a result that predates them
    stamp,        \* the client's hard-failure back-off mark (HardFailureStamps)
    hf,           \* the last scan died to a timeout or kill, inside the window
    respawn,      \* a new vulture process started while the root was stamped
    delivered,    \* process ids whose result was delivered as a delta
    dupDeliver,   \* one process result was delivered twice
    deliverFail   \* a failed scan result was delivered as a delta

vars == <<cur, made, turnEdits, row, scRun, scId, scSnap, w, en, slot, nextE,
          owed, rowOwed, lostCounted, wrote, fgn, fst, poisoned, crossWrite,
          crossDeliver, dupWrite, secondStart, staleCover, stamp, hf, respawn,
          delivered, dupDeliver, deliverFail>>

EIds == 1..MaxEnt
Res == {"ok", "fail", "threw"}

NoW == [on |-> FALSE, sid |-> 0, files |-> {}, prev |-> "none",
        snap |-> {}, fin |-> "run", joined |-> FALSE]
NoEnt == [on |-> FALSE, sess |-> 0, files |-> {}, prev |-> "none",
          carry |-> {}, st |-> "run", sid |-> 0, snap |-> {},
          res |-> "ok", joined |-> FALSE]

TypeOK ==
    /\ cur \in 1..MaxSess
    /\ made \subseteq Edits
    /\ turnEdits \subseteq Edits
    /\ row.kind \in {"none", "good", "bad"}
    /\ row.snap \subseteq Edits
    /\ scRun \in BOOLEAN
    /\ scId \in 0..MaxScan
    /\ scSnap \subseteq Edits
    /\ w.on \in BOOLEAN
    /\ w.fin \in {"run", "ok", "fail", "threw"}
    /\ w.joined \in BOOLEAN
    /\ \A i \in EIds : en[i].on \in BOOLEAN /\ en[i].carry \subseteq Edits
    /\ \A s \in 1..MaxSess : slot[s] \in 0..MaxEnt
    /\ nextE \in 1..(MaxEnt + 1)
    /\ owed \subseteq Edits
    /\ rowOwed \subseteq Edits
    /\ lostCounted \subseteq Edits
    /\ wrote \subseteq 1..MaxScan
    /\ delivered \subseteq 1..MaxScan
    /\ {fgn, fst, poisoned, crossWrite, crossDeliver, dupWrite, secondStart,
        staleCover, stamp, hf, respawn, dupDeliver, deliverFail} \subseteq BOOLEAN

\* The cell a session's entry lives in (:540-548). "module" is round 1's map.
SlotOf(s) == IF EntryScope = "session" THEN s ELSE 1
Vis == slot[SlotOf(cur)]
VisEnt == IF Vis = 0 THEN NoEnt ELSE en[Vis]
InFlightEnt == VisEnt.on /\ VisEnt.st # "settled"

\* wouldPoisonCache (:508-513): a failure over a good row.
Poisons(kind, guard) == kind = "bad" /\ guard = "good"
\* The row each writer compares with.
GuardOf(startKind) == IF Poison = "start" THEN startKind ELSE row.kind

CanStart == scRun \/ scId < MaxScan

\* Nothing else runs between a scan's end and its handlers: the .then
\* callbacks of one promise run in one microtask checkpoint, before any host
\* event (an edit, a turn_end, a session replacement). Without this the model
\* would explore orders the runtime cannot produce.
Quiet == /\ ~w.on
         /\ \A i \in EIds : ~(en[i].on /\ en[i].st \in Res)

\* :2703-2718 -- the back-off: a root whose last scan died to a timeout or a
\* kill is skipped. Two readers: the failed row in the cache (previousFailedHard,
\* :2703) and the stamp the client set where that scan settled
\* (recentHardFailure, dead-code-client.ts:238).
Blocked == row.kind = "bad" \/ (Backoff = "both" /\ stamp)
TakeBlocked == TakeBackoff = "on" /\ Blocked

Init ==
    /\ cur = 1
    /\ made = {}
    /\ turnEdits = {}
    /\ row \in {[kind |-> "none", snap |-> {}], [kind |-> "good", snap |-> {}]}
    /\ scRun = FALSE
    /\ scId = 0
    /\ scSnap = {}
    /\ w = NoW
    /\ en = [i \in EIds |-> NoEnt]
    /\ slot = [s \in 1..MaxSess |-> 0]
    /\ nextE = 1
    /\ owed = {}
    /\ rowOwed = {}
    /\ lostCounted = {}
    /\ wrote = {}
    /\ fgn = FALSE
    /\ fst = FALSE
    /\ poisoned = FALSE
    /\ crossWrite = FALSE
    /\ crossDeliver = FALSE
    /\ dupWrite = FALSE
    /\ secondStart = FALSE
    /\ staleCover = FALSE
    /\ stamp = FALSE
    /\ hf = FALSE
    /\ respawn = FALSE
    /\ delivered = {}
    /\ dupDeliver = FALSE
    /\ deliverFail = FALSE

\* modifiedFiles() (:2554): the agent edits a file.
Edit(e) ==
    /\ Quiet
    /\ e \in Edits \ made
    /\ made' = made \cup {e}
    /\ turnEdits' = turnEdits \cup {e}
    /\ UNCHANGED <<cur, row, scRun, scId, scSnap, w, en, slot, nextE, owed,
                   rowOwed, lostCounted, wrote, fgn, fst, poisoned, crossWrite,
                   crossDeliver, dupWrite, secondStart, staleCover, stamp, hf, respawn,
                   delivered, dupDeliver, deliverFail>>

\* client.analyze(cwd) (:2727): start the process, or JOIN the one running
\* (dead-code-client.ts:458). `prev` is the row read first (:2698). `joined`
\* is what joinedEarlierScan reads: the result's scannedAt predates the call.
StartScan(F) ==
    /\ w' = [on |-> TRUE,
             sid |-> IF scRun THEN scId ELSE scId + 1,
             files |-> F, prev |-> row.kind,
             snap |-> IF scRun THEN scSnap ELSE made, fin |-> "run",
             joined |-> scRun]
    /\ scId' = IF scRun THEN scId ELSE scId + 1
    /\ scSnap' = IF scRun THEN scSnap ELSE made
    /\ scRun' = TRUE
    /\ secondStart' = (secondStart \/ InFlightEnt)
    /\ respawn' = (respawn \/ (~scRun /\ hf))

\* :2688-2692 -- an entry is in flight: this turn's files wait in its carry.
TurnEndCarry ==
    /\ InFlight = "carry"
    /\ Quiet
    /\ InFlightEnt
    /\ turnEdits # {}
    /\ en' = IF CarryRec = "on"
                THEN [en EXCEPT ![Vis].carry = @ \cup turnEdits]
                ELSE en
    /\ owed' = owed \cup turnEdits
    /\ turnEdits' = {}
    /\ UNCHANGED <<cur, made, row, scRun, scId, scSnap, w, slot, nextE,
                   rowOwed, lostCounted, wrote, fgn, fst, poisoned, crossWrite,
                   crossDeliver, dupWrite, secondStart, staleCover, stamp, hf, respawn,
                   delivered, dupDeliver, deliverFail>>

\* :2677-2686 -- a settled entry is taken: delivered once, then removed; its
\* carry joins this turn's scan files (:2693), which may start a scan.
TurnEndTake ==
    /\ Quiet
    /\ Late # "neverTake"
    /\ VisEnt.on /\ VisEnt.st = "settled"
    /\ LET e == VisEnt
           \* #4154 J1: a joined entry's files join the next scan.
           F == turnEdits \cup e.carry
                \cup (IF Join = "carry" /\ e.joined THEN e.files ELSE {})
       IN /\ crossDeliver' = (crossDeliver \/ e.sess # cur)
          \* A file the result predates is neither covered by it nor sent on.
          /\ staleCover' = (staleCover \/ ~((e.files \ e.snap) \subseteq F))
          /\ dupDeliver' = (dupDeliver \/ e.sid \in delivered)
          /\ delivered' = delivered \cup {e.sid}
          /\ deliverFail' = (deliverFail \/ e.res # "ok")
          /\ en' = [en EXCEPT ![Vis] = NoEnt]
          /\ slot' = [slot EXCEPT ![SlotOf(cur)] = 0]
          /\ turnEdits' = {}
          /\ owed' = owed \ F
          \* :2703-2718 follows the take (a stamped root skips the scan; the
          \* mark can come from a scan outside the lane: ForeignStamp).
          /\ \/ /\ (F = {} \/ TakeBlocked)
                /\ UNCHANGED <<w, scRun, scId, scSnap, secondStart, respawn>>
             \/ /\ F # {}
                /\ ~TakeBlocked
                /\ CanStart
                /\ StartScan(F)
    /\ UNCHANGED <<cur, made, row, nextE, rowOwed, lostCounted, wrote, fgn, fst,
                   poisoned, crossWrite, dupWrite, stamp, hf>>

\* :2693-2727 -- InlineScan: no entry, so this turn starts and awaits a scan.
TurnEndStart ==
    /\ Quiet
    /\ ~VisEnt.on
    /\ turnEdits # {}
    /\ ~Blocked
    /\ CanStart
    /\ StartScan(turnEdits)
    /\ owed' = owed \ turnEdits
    /\ turnEdits' = {}
    /\ UNCHANGED <<cur, made, row, en, slot, nextE, rowOwed, lostCounted,
                   wrote, fgn, fst, poisoned, crossWrite, crossDeliver, dupWrite,
                   staleCover, stamp, hf, delivered, dupDeliver, deliverFail>>

\* :2710-2718 -- the back-off: no scan, the turn's files are skipped and the
\* row says so (`python:backoff:`).
TurnEndSkip ==
    /\ Quiet
    /\ ~VisEnt.on
    /\ turnEdits # {}
    /\ Blocked
    /\ turnEdits' = {}
    /\ UNCHANGED <<cur, made, row, scRun, scId, scSnap, w, en, slot, nextE,
                   owed, rowOwed, lostCounted, wrote, fgn, fst, poisoned,
                   crossWrite, crossDeliver, dupWrite, secondStart,
                   staleCover, stamp, hf, respawn,
                   delivered, dupDeliver, deliverFail>>

\* Mutant InlineWhileParked: the :2688 branch is gone, so a turn_end starts
\* (joins) its own scan with an entry in flight.
TurnEndStartBesideEntry ==
    /\ InFlight = "scan"
    /\ Quiet
    /\ InFlightEnt
    /\ turnEdits # {}
    /\ ~Blocked
    /\ CanStart
    /\ StartScan(turnEdits)
    /\ owed' = owed \ turnEdits
    /\ turnEdits' = {}
    /\ UNCHANGED <<cur, made, row, en, slot, nextE, rowOwed, lostCounted,
                   wrote, fgn, fst, poisoned, crossWrite, crossDeliver, dupWrite,
                   staleCover, stamp, hf, delivered, dupDeliver, deliverFail>>

\* :2737-2753 and :608-629 -- Park: bounded() gave up (budget or Escape). The
\* scan keeps running; the entry records what the scan was started for and
\* the row it was started against.
Abandon ==
    /\ w.on
    /\ nextE <= MaxEnt
    /\ IF Late = "dropAtPark"
          THEN UNCHANGED <<en, slot, nextE>>
          ELSE /\ en' = [en EXCEPT ![nextE] = [on |-> TRUE, sess |-> cur,
                        files |-> w.files, prev |-> w.prev, carry |-> {},
                        st |-> w.fin, sid |-> w.sid, snap |-> w.snap,
                        res |-> "ok", joined |-> w.joined]]
               /\ slot' = [slot EXCEPT ![SlotOf(cur)] = nextE]
               /\ nextE' = nextE + 1
    /\ w' = NoW
    /\ UNCHANGED <<cur, made, turnEdits, row, scRun, scId, scSnap, owed,
                   rowOwed, lostCounted, wrote, fgn, fst, poisoned, crossWrite,
                   crossDeliver, dupWrite, secondStart, staleCover, stamp, hf, respawn,
                   delivered, dupDeliver, deliverFail>>

\* :2755-2786 -- Await finished inside the budget: the inline writer. #4154
\* J1: a joined await is not finished inline; Abandon parks it instead.
InlineFinish ==
    /\ w.on
    /\ w.fin # "run"
    /\ Join = "trust" \/ ~w.joined
    /\ LET kind == IF w.fin = "ok" THEN "good" ELSE "bad"
           doWrite == w.fin # "threw" /\ ~Poisons(kind, GuardOf(w.prev))
       IN /\ row' = IF doWrite
                       THEN [kind |-> kind,
                             snap |-> IF kind = "good" THEN w.snap ELSE {}]
                       ELSE row
          /\ poisoned' = (poisoned \/ (doWrite /\ kind = "bad"
                                         /\ row.kind = "good"))
          /\ dupWrite' = (dupWrite \/ (doWrite /\ w.sid \in wrote))
          /\ wrote' = IF doWrite THEN wrote \cup {w.sid} ELSE wrote
          /\ rowOwed' = IF w.fin = "ok" THEN w.snap ELSE rowOwed
          /\ staleCover' = (staleCover \/ (w.fin = "ok"
                                           /\ ~(w.files \subseteq w.snap)))
          /\ dupDeliver' = (dupDeliver \/ (w.fin = "ok" /\ w.sid \in delivered))
          /\ delivered' = IF w.fin = "ok" THEN delivered \cup {w.sid} ELSE delivered
    /\ w' = NoW
    \* Pre-#4117: the mark was the failed row, written only for a scan that
    \* settled inside the turn.
    /\ stamp' = IF StampAt = "turn"
                  THEN (CASE w.fin = "fail" -> TRUE
                          [] w.fin = "ok" -> FALSE
                          [] OTHER -> stamp)
                  ELSE stamp
    /\ UNCHANGED <<cur, made, turnEdits, scRun, scId, scSnap, en, slot, nextE,
                   owed, lostCounted, fgn, fst, crossWrite, crossDeliver,
                   secondStart, hf, respawn, deliverFail>>

\* The vulture process ends (dead-code-client.ts:461). Everything attached to
\* it sees the same result.
ScanComplete(r) ==
    /\ scRun
    /\ scRun' = FALSE
    /\ w' = IF w.on /\ w.sid = scId THEN [w EXCEPT !.fin = r] ELSE w
    /\ en' = [i \in EIds |->
                 IF en[i].on /\ en[i].sid = scId /\ en[i].st = "run"
                    THEN [en[i] EXCEPT !.st = r] ELSE en[i]]
    \* HardFailureStamps.settle (hard-failure-summary.ts:31): a success lifts the
    \* mark, a timeout or kill sets it, a rejection never reaches it.
    /\ hf' = (CASE r = "fail" -> TRUE
                 [] r = "ok" -> FALSE
                 [] OTHER -> hf)
    /\ stamp' = IF StampAt = "settle"
                  THEN (CASE r = "fail" -> TRUE
                          [] r = "ok" -> FALSE
                          [] OTHER -> stamp)
                  ELSE stamp
    /\ UNCHANGED <<cur, made, turnEdits, row, scId, scSnap, slot, nextE,
                   owed, rowOwed, lostCounted, wrote, fgn, fst, poisoned,
                   crossWrite, crossDeliver, dupWrite, secondStart,
                   staleCover, respawn, delivered, dupDeliver, deliverFail>>

\* :630-663 -- the .then handler of a parked scan. An ended session writes
\* nothing and is dropped (:632-635); otherwise the row is written unless it
\* would poison (:639-648); a failure or a throw drops the entry
\* (dropLateDeadCodeScan :587-600, which deletes the cell's key, :588);
\* a success is parked for the next turn_end (:659).
EntrySettle(i) ==
    /\ en[i].on
    /\ en[i].st \in Res
    /\ LET e == en[i]
           sl == SlotOf(e.sess)
           ended == Settle = "checked" /\ e.sess # cur
           kind == IF e.st = "ok" THEN "good" ELSE "bad"
           guard == IF Poison = "start" THEN e.prev ELSE row.kind
           kept == Late = "keep" \/ e.st # "ok"
           writes == /\ ~ended
                     /\ e.st # "threw"
                     /\ ~(Late = "dropAtSettle" /\ e.st = "ok")
                     /\ (SettlePoison = "unguarded" \/ ~Poisons(kind, guard))
           gone == ended \/ e.st = "threw"
                   \/ (e.st = "fail" /\ Late # "keepFailed")
                   \/ (Late = "dropAtSettle" /\ e.st = "ok")
       IN /\ row' = IF writes
                       THEN [kind |-> kind,
                             snap |-> IF kind = "good" THEN e.snap ELSE {}]
                       ELSE row
          /\ poisoned' = (poisoned \/ (writes /\ kind = "bad"
                                         /\ row.kind = "good"))
          /\ crossWrite' = (crossWrite \/ (writes /\ e.sess # cur))
          /\ dupWrite' = (dupWrite \/ (writes /\ e.sid \in wrote))
          /\ wrote' = IF writes THEN wrote \cup {e.sid} ELSE wrote
          /\ rowOwed' = IF ~ended /\ e.st = "ok" THEN e.snap ELSE rowOwed
          /\ IF gone
                THEN /\ en' = [en EXCEPT ![i] = NoEnt]
                     /\ slot' = [slot EXCEPT ![sl] = 0]
                     /\ owed' = owed \ e.carry
                     /\ lostCounted' = IF ended THEN lostCounted
                                       ELSE lostCounted \cup (e.carry \cap owed)
                ELSE /\ en' = [en EXCEPT ![i].st = "settled", ![i].res = e.st]
                     /\ UNCHANGED <<slot, owed, lostCounted>>
    /\ UNCHANGED <<cur, made, turnEdits, scRun, scId, scSnap, w, nextE, fgn, fst,
                   crossDeliver, secondStart, staleCover, stamp, hf, respawn,
                   delivered, dupDeliver, deliverFail>>

\* runtime-coordinator.ts:652-654 -- /new, fork, reload or quit retires the
\* scope. The new scope has its own cell; the old entries are unreachable.
SessionReplace ==
    /\ Quiet
    /\ cur < MaxSess
    /\ cur' = cur + 1
    /\ turnEdits' = {}
    /\ UNCHANGED <<made, row, scRun, scId, scSnap, w, en, slot, nextE, owed,
                   rowOwed, lostCounted, wrote, fgn, fst, poisoned, crossWrite,
                   crossDeliver, dupWrite, secondStart, staleCover, stamp, hf, respawn,
                   delivered, dupDeliver, deliverFail>>

\* project-diagnostics/fresh-fetch.ts:858-870 -- a fresh fetch stores a good
\* row from outside the lane, once, while no turn_end handler is awaiting
\* (the agent that calls lens_diagnostics is stopped for that wait) and
\* never between a scan's end and its .then handler (one microtask run).
ForeignWrite ==
    /\ Foreign = "on"
    /\ ~fgn
    /\ Quiet
    /\ row' = [kind |-> "good", snap |-> made]
    /\ fgn' = TRUE
    /\ UNCHANGED <<cur, made, turnEdits, scRun, scId, scSnap, w, en, slot,
                   nextE, owed, rowOwed, lostCounted, wrote, fst, poisoned,
                   crossWrite, crossDeliver, dupWrite, secondStart,
                   staleCover, stamp, hf, respawn,
                   delivered, dupDeliver, deliverFail>>

\* HARD_FAILURE_BACKOFF_MS (hard-failure-summary.ts:20): the mark expires.
Expire ==
    /\ stamp \/ hf
    /\ stamp' = FALSE
    /\ hf' = FALSE
    /\ UNCHANGED <<cur, made, turnEdits, row, scRun, scId, scSnap, w, en, slot,
                   nextE, owed, rowOwed, lostCounted, wrote, fgn, fst, poisoned,
                   crossWrite, crossDeliver, dupWrite, secondStart,
                   staleCover, respawn, delivered, dupDeliver, deliverFail>>

\* CacheManager.readCache (cache-manager.ts:255): a cache row older than its
\* maximum age reads as absent, so a failed row stops blocking.
ExpireBadRow ==
    /\ row.kind = "bad"
    /\ row' = [kind |-> "none", snap |-> {}]
    /\ UNCHANGED <<cur, made, turnEdits, scRun, scId, scSnap, w, en, slot,
                   nextE, owed, rowOwed, lostCounted, wrote, fgn, fst, poisoned,
                   crossWrite, crossDeliver, dupWrite, secondStart,
                   staleCover, stamp, hf, respawn,
                   delivered, dupDeliver, deliverFail>>

\* A scan outside the lane that dies to a timeout or a kill stamps the shared
\* client: lens_diagnostics' fresh fetch (fresh-fetch.ts:858, a failure writes no
\* row, recordFailed) or the session_start scan (runtime-session.ts:1522). The
\* mark can land while a settled entry waits for its take.
ForeignStamp ==
    /\ Quiet
    /\ ~scRun
    /\ ~stamp
    /\ ~fst
    /\ fst' = TRUE
    /\ stamp' = TRUE
    /\ hf' = TRUE
    /\ UNCHANGED <<cur, made, turnEdits, row, scRun, scId, scSnap, w, en, slot,
                   nextE, owed, rowOwed, lostCounted, wrote, fgn, poisoned,
                   crossWrite, crossDeliver, dupWrite, secondStart,
                   staleCover, respawn, delivered, dupDeliver, deliverFail>>

\* Stutter when no lane work is pending (or a model bound is spent). With
\* CHECK_DEADLOCK on, a state that has work and no enabled action is then a
\* lane that cannot make progress: the bounded form of "a settled result is
\* delivered" (#4120 L1: the take gone).
Idle ==
    /\ \/ /\ Quiet
          /\ turnEdits = {}
          /\ ~(VisEnt.on /\ VisEnt.st = "settled")
       \/ ~CanStart
       \/ nextE > MaxEnt
    /\ UNCHANGED vars

Next ==
    \/ \E e \in Edits : Edit(e)
    \/ TurnEndCarry
    \/ TurnEndTake
    \/ TurnEndStart
    \/ TurnEndSkip
    \/ TurnEndStartBesideEntry
    \/ Abandon
    \/ InlineFinish
    \/ \E r \in Res : ScanComplete(r)
    \/ \E i \in EIds : EntrySettle(i)
    \/ SessionReplace
    \/ ForeignWrite
    \/ Expire
    \/ ExpireBadRow
    \/ ForeignStamp
    \/ Idle

Spec == Init /\ [][Next]_vars

(* One scan's result is written to the row once: the inline writer while no  *)
(* entry exists, the settle handler while one does.                          *)
SingleWriter == ~dupWrite

(* An ended session's settle writes nothing, and an entry or a settled       *)
(* result is never delivered in another session.                             *)
NoCrossSession == ~crossWrite /\ ~crossDeliver

(* A failed scan never replaces a good row (#925, #1467).                    *)
NoPoison == ~poisoned

(* A file edited while a scan runs is in the carry of a live entry until a   *)
(* started scan covers it, or it was lost with a counted drop.               *)
NoLostEdit ==
    owed \subseteq UNION {en[i].carry : i \in {j \in EIds : en[j].on}}

(* The strict form: a counted drop (a failed or throwing in-flight scan)     *)
(* loses no carried edit. VERIFY_4120 V2, a documented degradation.          *)
NoLostEditStrict == lostCounted = {}

(* No scan starts beside an entry that is still in flight.                   *)
NoSecondStart == ~secondStart

(* Bounded liveness, part 1: a running scan always has a consumer that will *)
(* keep its result, the awaiting handler or a live entry. Round 1 had none:  *)
(* bounded() gave up and the result was never written or delivered (F1).     *)
NoOrphanScan ==
    scRun => \/ (w.on /\ w.sid = scId)
             \/ \E i \in EIds : en[i].on /\ en[i].sid = scId /\ en[i].st = "run"

(* Bounded liveness, part 2: once a live handler has seen a successful scan, *)
(* the row is a good row at least that fresh.                                *)
NoLostRow == rowOwed \subseteq row.snap /\ (rowOwed # {} => row.kind = "good")

(* A root whose scan died to a timeout or a kill is not scanned again until  *)
(* the mark expires or a scan succeeds (#1467, #3872, #4117).                *)
NoRespawnWhileStamped == ~respawn

(* A scan's result is delivered as a delta at most once (:2678 removes the  *)
(* entry it takes).                                                          *)
NoDoubleDelivery == ~dupDeliver

(* A failed scan result is never delivered as a delta (#4120 L9).           *)
NoDeliverFailed == ~deliverFail

(* A file is never left with only a result that predates its edit: a joined *)
(* result is not finished inline, and its files join the next scan (#4154).   *)
NoStaleCover == ~staleCover
=============================================================================
