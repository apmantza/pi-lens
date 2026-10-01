-------------------------- MODULE SessionLifecycle --------------------------
(***************************************************************************)
(* The composition layer of #3609: one process's session-scoped stores     *)
(* across every pi session transition, as merged by S1 (#3732, scope       *)
(* tickets and the lineage handle), S3 (#3759, late writers fenced by the  *)
(* captured scope) and S2 (#3777, the session hand-off), with #3757's      *)
(* per-scope advisory queue and #3668's gap classification.                *)
(*                                                                         *)
(* Content-level truth stays in the sibling models (ReadGuard,             *)
(* SessionStraddle, FormatDrain, SessionRegistry). Here a store's content  *)
(* is abstracted to FACTS [e: entry, o: origin scope]: "scope o recorded   *)
(* something about the tool result at conversation entry e". The read      *)
(* guard (RG) is the fact store. Beside it: the turn counter (TC), the     *)
(* widget's write-order guard (WG), the LSP fleet (LS), the registry entry *)
(* (RE), the lazy-tool activations (LZ, origin scopes, no entry) and the   *)
(* agent advisory queue (AD, one advisory per producer scope).             *)
(*                                                                         *)
(* Identity (S1, clients/session-scope.ts): a scope is a ticket drawn from *)
(* one process counter. A handle is current while its scope is live and,   *)
(* at branch level, while its branch epoch is unchanged. Nothing else.     *)
(*                                                                         *)
(* Host transitions (pi 0.85.1):                                           *)
(*   /new, resume, /fork, /clone : session_shutdown, then a NEW            *)
(*       activation's session_start. The two halves are separate steps, so *)
(*       writers can land between them. pi sends reason "fork" for /clone. *)
(*   /reload       : the same, same session file, and the entry module    *)
(*       may be re-evaluated (jiti fallback).                              *)
(*   quit, pi --fork: the process exits; pi --fork starts a new process    *)
(*       whose only channel is the parent's sidecar.                       *)
(*   /tree         : no new activation; the branch shrinks, epoch bumps.   *)
(*   LSP idle reset: pi-lens' own timer; resets the LSP service only.      *)
(*   subagent start/stop: an in-process subagent binds its own session     *)
(*       while the primary is live (I6).                                   *)
(*   subagent /reload, /fork: its own replacement. A start in the          *)
(*       primary's replacement gap with a reason other than "startup" is   *)
(*       classified primary (#3668 row 17, a stated residual).             *)
(*                                                                         *)
(* Writers begin in a live scope and land at ANY later step. pi refuses    *)
(* /tree and /reload while streaming, but agent_settled handlers run after *)
(* the run is marked inactive (I1) and bounded handlers are abandoned      *)
(* without being cancelled (I2), so this over-approximation hides nothing  *)
(* the host allows.                                                        *)
(*                                                                         *)
(* Policy, Fence and SecPolicy are tables as constants: TargetPolicy is    *)
(* the merged table (it equals the design's, with the widget's fork row    *)
(* amended by S2); LegacyPolicy is master at df5fb8abb, before #3669 and   *)
(* S1-S3. FixParts selects the mechanisms:                                 *)
(*   "entryCapture"      S3 (and D2): a writer's lineage handle is the one *)
(*                       it captured at hook entry; without it the handle  *)
(*                       is resolved when the write lands, from the        *)
(*                       module-level runtime (or, for the heartbeat, the  *)
(*                       registry intent)                                  *)
(*   "handoffAtShutdown" S2 (D3): the hand-off slot is written at          *)
(*                       session_shutdown, keyed by (start reason,         *)
(*                       successor file); without it, at                   *)
(*                       session_before_fork, as #3669 shipped it (pre-S2) *)
(*   "consumeOnMatch"    S2 (F2): only a primary fork or reload start      *)
(*                       takes the slot, and only on an equal key; an      *)
(*                       unmatched slot stays in place, with no expiry.    *)
(*                       Without it, every start takes the slot (design    *)
(*                       section 3.4 as written) and discards it unmatched *)
(*   "processOrderTurn"  S1 (N3): the write-order turn is a process        *)
(*                       counter; without it, a field of each entry-module *)
(*                       evaluation                                        *)
(*   "dedupe"            the #2890 duplicate session_start gate            *)
(*   "recordDrop"        S1 (F1): a dropped read-guard write whose entry   *)
(*                       is still on its conversation's branch leaves a    *)
(*                       degradation record                                *)
(*   "advisoryScope"     #3757: a context call receives only the           *)
(*                       advisories its own scope queued, and a retired    *)
(*                       scope's advisories are dropped with a record;     *)
(*                       without it, the first context call takes them all *)
(*   "ticketKey"         #3819: a file-less slot is keyed by the S1 ticket *)
(*                       of the scope that left it, bound to the session   *)
(*                       manager it left from, and a start's key is the    *)
(*                       ticket bound to the manager pi hands it           *)
(*                       (Carrier); without it, both keys are undefined    *)
(*                       and the reason alone matches                      *)
(*   "demotedDiscard"    #3819 r2: a declined (demoted) start whose key    *)
(*                       matches the slot discards it without adopting,    *)
(*                       so the demoted session cannot take it stale when  *)
(*                       it later classifies primary; no other start       *)
(*                       removes a slot except by taking it                *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS
    Transitions,    \* the host transitions this config enables, a subset of
                    \*   {"New","Resume","Fork","Clone","CancelFork","Reload",
                    \*    "Quit","PiFork","Tree","IdleReset","SecStart",
                    \*    "SecEnd","SecTurn","SecReload","SecFork","Dup"}
    Writers,        \* the writers in play, a subset of
                    \*   {"read","secRead","heartbeat","lsp","widget",
                    \*    "advisory","activate"}
    FixParts,       \* see the header
    FileLess,       \* the conversations whose sessions have no session file
                    \*   (pi --no-session, an in-memory subagent): their slot
                    \*   key is undefined
    MaxSteps,       \* bound on host transitions
    MaxTurns,       \* bound on turn_start events (primary and secondary)
    LateHandlers,   \* TRUE: a read-guard writer may hold any entry of its
                    \*   branch, so its handler outlived a later entry;
                    \*   FALSE: it holds the branch's newest entry
    Policy(_, _),   \* [store, reason] -> action
    Fence(_),       \* store -> "branch" | "session" | "service" | "none"
    SecPolicy(_)    \* store -> "own" | "shared"

Has(p) == p \in FixParts

-----------------------------------------------------------------------------
(* The policy tables (design section 4, maintainer decisions D1-D8, S2).   *)

Starts  == {"startup", "new", "resume", "fork", "clone", "piFork", "reload"}
Reasons == Starts \cup {"tree", "shutdown", "idle"}
Actions == {"reset", "carry", "filter-by-branch", "import-parent",
            "rehydrate", "none"}
Stores  == {"RG", "TC", "WG", "LS", "LT", "LZ", "AD"}

\* RG is the read guard, reads and authorship together (D5: authorship
\* carries on /reload). TC: turn counters and per-turn maps. WG: the widget's
\* write-order guards, in a clients/ module that outlives the factory re-run,
\* so /tree, /reload and an in-process fork keep them (S2, #3589). LS: the
\* LSP fleet. LT: the lens toggles (no model state). LZ: the lazy-tool
\* activations (#3604; D7: /tree keeps them). AD: the advisory queue, which
\* only /reload carries (S2, from the slot only).
TargetPolicy(s, r) ==
    CASE s = "RG" ->
            [startup |-> "rehydrate", new |-> "reset", resume |-> "rehydrate",
             fork |-> "import-parent", clone |-> "import-parent",
             piFork |-> "import-parent", tree |-> "filter-by-branch",
             reload |-> "filter-by-branch", shutdown |-> "none",
             idle |-> "none"][r]
      [] s \in {"TC", "LT"} -> IF r \in Starts THEN "reset" ELSE "none"
      [] s = "WG" -> IF r \in {"tree", "reload", "fork", "clone"} THEN "carry"
                     ELSE IF r \in Starts THEN "reset" ELSE "none"
      [] s = "LZ" -> IF r \in {"startup", "resume"} THEN "rehydrate"
                     ELSE IF r \in {"fork", "clone", "piFork"} THEN "import-parent"
                     ELSE IF r = "reload" THEN "carry"
                     ELSE IF r = "new" THEN "reset" ELSE "none"
      [] s = "AD" -> IF r = "reload" THEN "carry" ELSE "none"
      [] s = "LS" -> IF r \in {"shutdown", "idle"} THEN "reset" ELSE "none"

\* master at df5fb8abb (2026-09-27), before #3669 and S1-S3. The read guard:
\* resetForSession on every primary session_start, so /reload resets it
\* (N1); the fork stash was an activation-closure `let`
\* (pendingForkReadGuard), which the fork's new activation could not see, so
\* /fork and /clone started clean; no session_tree handler. The lazy-tool memory was a
\* file-keyed in-process map, so pi --fork started without it (#3604). No
\* advisory crossed a start (the queue was untagged, see "advisoryScope").
\* The widget's fork start cleared it (#3589).
LegacyPolicy(s, r) ==
    CASE s = "RG" ->
            [startup |-> "rehydrate", new |-> "reset", resume |-> "rehydrate",
             fork |-> "reset", clone |-> "reset", piFork |-> "reset",
             tree |-> "none", reload |-> "reset", shutdown |-> "none",
             idle |-> "none"][r]
      [] s = "LZ" -> IF r = "piFork" THEN "reset" ELSE TargetPolicy(s, r)
      [] s = "AD" -> "none"
      [] s = "WG" -> IF r \in {"fork", "clone"} THEN "reset" ELSE TargetPolicy(s, r)
      [] OTHER -> TargetPolicy(s, r)

TargetFence(s) ==
    CASE s = "RG" -> "branch" [] s = "TC" -> "session"
      [] s = "LS" -> "service" [] OTHER -> "none"

\* Before S1: G5's handles (#3568, #3576) fence at session level only.
LegacyFence(s) == IF s = "RG" THEN "session" ELSE TargetFence(s)

\* The design (S4 for RG and TC).
TargetSec(s) ==
    CASE s \in {"RG", "TC", "LZ"} -> "own" [] OTHER -> "shared"

\* Merged master: S2 gave the lazy-tool memory a cell per scope (#3653); a
\* subagent's handlers still reach the module-level runtime, so its read
\* guard and turn counter are the primary's (#3607, N2, #3613 open).
MergedSec(s) == IF s = "LZ" THEN "own" ELSE "shared"

\* Before S2, the subagent shared everything.
LegacySec(s) == "shared"

-----------------------------------------------------------------------------
(* The world.                                                              *)

Tickets == 1..(MaxSteps + 2)
Files   == {"A", "N", "F", "C", "P", "S", "T"}  \* initial, /new, /fork,
                                                \* /clone, pi --fork, the
                                                \* subagent's, its fork
Entries == 1..4
Facts   == [e : Entries, o : Tickets]
FlightIds == Writers \ {"widget", "activate"}

InitBranch(f) ==
    CASE f = "A" -> {1, 2} [] f = "N" -> {3} [] f = "S" -> {4} [] OTHER -> {}

Max(S) == CHOOSE x \in S : \A y \in S : y <= x
\* /fork restarts before the chosen user message: the copied branch loses its
\* last entry. /clone copies the whole branch.
ForkBranch(b) == IF b = {} THEN {} ELSE b \ {Max(b)}

\* The slot key's file: a file-less session keys on undefined.
Key(f) == IF f \in FileLess THEN "none" ELSE f

\* The session_start reason pi sends: /clone is a fork.
SR(k) == IF k = "clone" THEN "fork" ELSE k
\* The start reasons whose source list begins with the slot (SOURCES).
SlotReasons == {"fork", "reload"}

NoSlot == [has |-> FALSE, from |-> 0, reason |-> "-", file |-> "-",
           facts |-> {}, act |-> {}, adv |-> {}]
NoPend == [k |-> "none", from |-> 0, file |-> "-", target |-> "-"]
IdleW  == [pc |-> "idle", s |-> 0, ep |-> 0, e |-> 0, svc |-> 0]

RegOn   == "heartbeat" \in Writers
LspOn   == "lsp" \in Writers
AdvOn   == "advisory" \in Writers
ActOn   == "activate" \in Writers
TurnsOn == MaxTurns > 0

VARIABLES
    st, role, sess, ep,      \* scope table: state, role, session file, branch epoch
    why,                     \* scope -> the reason it retired
    primary,                 \* the registered primary scope, 0 when none
    last,                    \* the scope the module-level runtime serves
    nxt,                     \* next ticket (one process counter, S1)
    pend,                    \* a replacement between its shutdown and its start
    forking,                 \* "no" | "fork" | "clone": after session_before_fork
    branch,                  \* file -> entries on its current branch
    cell,                    \* scope -> RG facts
    imp,                     \* scope -> facts it inherited (hand-off, sidecar)
    lin,                     \* file -> the scopes whose conversation its history
                             \* holds (/fork, /clone and pi --fork copy it); the
                             \* truth the invariants check, whatever the policy
    slot,                    \* the process hand-off slot (one, replaced)
    taken,                   \* every slot take: [by: taker, from: writer]
    side, sideAct,           \* per-file sidecar: RG facts, activations
    wr,                      \* in-flight writers
    entry, intent, reg,      \* registry: roots in this process's entry, the
                             \* re-registration intent, per-scope registration
    svc, fleet,              \* LSP service generation; servers [g: generation, o]
    turn, begun, turns,      \* turn counters, turn_starts each scope issued, total
    procTurn, evalTurn,      \* the order turn: process-wide, per evaluation
    wgTok, wgDone,           \* the widget guard's stored token; written this turn
    lastTok, prevMax,        \* the last order token drawn, the max before it
    ownDrop,                 \* a guard dropped a write whose own lineage was current
    recorded,                \* dropped RG facts that left a degradation record
    resets, dupDone,         \* session_start mutation passes per scope; dup seen
    landed, reads,           \* RG facts that reached a cell; RG writes completed
    predOf,                  \* scope -> the scope its session_start replaced
    act, acts,               \* scope -> activations it holds; every activation
    adv, advOut, advDrop,    \* queued advisories [o, tag, late]; delivered
                             \* [o, to]; dropped with a record [o, why, late]
    steps, used

vars == <<st, role, sess, ep, why, primary, last, nxt, pend, forking, branch,
          cell, imp, lin, slot, taken, side, sideAct, wr, entry, intent, reg,
          svc, fleet, turn, begun, turns, procTurn, evalTurn, wgTok, wgDone,
          lastTok, prevMax, ownDrop, recorded, resets, dupDone, landed, reads,
          predOf, act, acts, adv, advOut, advDrop, steps, used>>

\* Groups for UNCHANGED.
lzV  == <<act, acts>>
adV  == <<adv, advOut, advDrop>>

Init ==
    /\ st = [t \in Tickets |-> IF t = 1 THEN "live" ELSE "free"]
    /\ role = [t \in Tickets |-> IF t = 1 THEN "primary" ELSE "-"]
    /\ sess = [t \in Tickets |-> IF t = 1 THEN "A" ELSE "-"]
    /\ ep = [t \in Tickets |-> 0]
    /\ why = [t \in Tickets |-> "-"]
    /\ primary = 1 /\ last = 1 /\ nxt = 2
    /\ pend = NoPend /\ forking = "no"
    /\ branch = [f \in Files |-> InitBranch(f)]
    /\ cell = [t \in Tickets |-> {}]
    /\ imp = [t \in Tickets |-> {}]
    /\ lin = [f \in Files |-> IF f = "A" THEN {1} ELSE {}]
    /\ slot = NoSlot /\ taken = {}
    /\ side = [f \in Files |-> {}]
    /\ sideAct = [f \in Files |-> {}]
    /\ wr = [x \in FlightIds |-> IdleW]
    /\ entry = IF RegOn THEN {1} ELSE {}
    /\ intent = IF RegOn THEN 1 ELSE 0
    /\ reg = [t \in Tickets |-> IF t = 1 /\ RegOn THEN "done" ELSE "-"]
    /\ svc = 0 /\ fleet = {}
    /\ turn = [t \in Tickets |-> 0] /\ begun = [t \in Tickets |-> 0]
    /\ turns = 0 /\ procTurn = 0 /\ evalTurn = 0
    /\ wgTok = 0 /\ wgDone = FALSE /\ lastTok = 0 /\ prevMax = 0
    /\ ownDrop = FALSE /\ recorded = {}
    /\ resets = [t \in Tickets |-> IF t = 1 THEN 1 ELSE 0]
    /\ dupDone = FALSE
    /\ landed = {} /\ reads = {}
    /\ predOf = [t \in Tickets |-> 0]
    /\ act = [t \in Tickets |-> {}] /\ acts = {}
    /\ adv = {} /\ advOut = {} /\ advDrop = {}
    /\ steps = 0 /\ used = {}

-----------------------------------------------------------------------------
(* Helpers.                                                                *)

\* The cell a write of scope t reaches: its own, or, when the store is
\* shared with secondaries, the one the module-level runtime serves.
CellOf(t) == IF role[t] = "secondary" /\ SecPolicy("RG") = "shared"
             THEN last ELSE t
ActCell(t) == IF role[t] = "secondary" /\ SecPolicy("LZ") = "shared"
              THEN last ELSE t

Ents(S) == {x.e : x \in S}

\* The order token a turn draws, and the counter it advances.
OrderNow == IF Has("processOrderTurn") THEN procTurn ELSE evalTurn

Draw ==
    /\ IF Has("processOrderTurn")
       THEN /\ procTurn' = procTurn + 1 /\ UNCHANGED evalTurn
            /\ lastTok' = procTurn + 1
       ELSE /\ evalTurn' = evalTurn + 1 /\ UNCHANGED procTurn
            /\ lastTok' = evalTurn + 1
    /\ prevMax' = IF lastTok > prevMax THEN lastTok ELSE prevMax
    /\ wgDone' = FALSE

HostOk == pend.k = "none" /\ forking = "no" /\ primary # 0 /\ steps < MaxSteps

\* Whether scope s began on its predecessor's pi session manager: pi keeps
\* the manager on /reload and on an in-memory /fork or /clone, and makes a
\* new one for /new, resume, a persisted fork, pi --fork and a subagent.
SameMgr(s) ==
    /\ predOf[s] # 0
    /\ why[predOf[s]] \in {"reload", "fork", "clone"}
    /\ why[predOf[s]] = "reload" \/ sess[s] \in FileLess

\* #3819 (stashHandoff's binding): the ticket of the last slot left from
\* scope s's session manager. A primary shutdown that stashes (Retire with a
\* slot reason) binds its ticket; a secondary's shutdown stashes nothing, so
\* it binds nothing.
RECURSIVE Carrier(_)
Carrier(s) ==
    IF s = 0 THEN 0
    ELSE IF role[s] = "primary" /\ Has("handoffAtShutdown")
            /\ why[s] \in {"reload", "fork", "clone"} THEN s
    ELSE IF SameMgr(s) THEN Carrier(predOf[s])
    ELSE 0

\* The ticket a start replacing scope s with reason k finds bound to the
\* manager pi hands it (only a manager-keeping transition inherits one).
Via(k, s) == IF k \in {"reload", "fork", "clone"} THEN Carrier(s) ELSE 0

\* takeHandoff (clients/session-scope.ts): the slot's key equals the start's
\* (start reason, session file). A file-less session's file is undefined;
\* under "ticketKey" its key is the ticket that left the slot (slot.from),
\* and the start's is c, the ticket bound to its manager (Via).
SlotMatch(r, f, c) ==
    /\ slot.has /\ slot.reason = r /\ slot.file = Key(f)
    /\ (Has("ticketKey") /\ f \in FileLess) => slot.from = c

\* The queue after a prune: under #3757, a retired scope's advisories go
\* (pruneRetiredAdvisories), each with a counted record.
AdvLive  == IF Has("advisoryScope") THEN {a \in adv : st[a.tag] = "live"}
            ELSE adv
AdvPrune == {[o |-> a.o, why |-> why[a.tag], late |-> a.late] : a \in adv \ AdvLive}

\* The advisory store's restore on /reload from the slot: re-tag the
\* predecessor's entry (any retired entry with the same advisory), else
\* queue it again (a prune in the gap dropped it).
Retag(A, carried, t) ==
    LET moved == {a \in A : a.o \in carried /\ st[a.tag] # "live"}
        fresh == {o \in carried : ~\E a \in moved : a.o = o}
    IN (A \ moved) \cup {[a EXCEPT !.tag = t] : a \in moved}
                   \cup {[o |-> o, tag |-> t, late |-> FALSE] : o \in fresh}

-----------------------------------------------------------------------------
(* Host transitions.                                                       *)

\* session_before_fork (0 ms, may not await). S2 deleted pi-lens' handler
\* (#3777); under "handoffAtShutdown" this action changes nothing but the
\* forking flag. Without it, it is #3669's pre-S2 stashForkHandoff: the
\* slot is filled here.
BeforeFork(k) ==
    /\ (k = "fork" /\ "Fork" \in Transitions)
       \/ (k = "clone" /\ "Clone" \in Transitions)
    /\ k \notin used
    /\ HostOk
    /\ forking' = k
    /\ slot' = IF Has("handoffAtShutdown") THEN slot
               ELSE [has |-> TRUE, from |-> primary, reason |-> "fork",
                     file |-> Key(IF k = "fork" THEN "F" ELSE "C"),
                     facts |-> cell[primary], act |-> act[primary],
                     adv |-> {a.o : a \in {b \in adv : b.tag = primary}}]
    /\ UNCHANGED <<st, role, sess, ep, why, primary, last, nxt, pend, branch,
                   cell, imp, lin, taken, side, sideAct, wr, entry,
                   intent, reg, svc, fleet, turn, begun, turns, procTurn,
                   evalTurn, wgTok, wgDone, lastTok, prevMax, ownDrop, recorded,
                   resets, dupDone, landed, reads, predOf, lzV, adV, steps, used>>

\* Another extension cancels the fork after session_before_fork (I3).
CancelFork ==
    /\ "CancelFork" \in Transitions /\ forking # "no" /\ steps < MaxSteps
    /\ forking' = "no" /\ steps' = steps + 1
    /\ UNCHANGED <<st, role, sess, ep, why, primary, last, nxt, pend, branch,
                   cell, imp, lin, slot, taken, side, sideAct, wr, entry,
                   intent, reg, svc, fleet, turn, begun, turns, procTurn,
                   evalTurn, wgTok, wgDone, lastTok, prevMax, ownDrop, recorded,
                   resets, dupDone, landed, reads, predOf, lzV, adV, used>>

TargetOf(k) ==
    CASE k = "new" -> "N" [] k = "resume" -> "A" [] k = "fork" -> "F"
      [] k = "clone" -> "C" [] OTHER -> "-"

RetireOk(k) ==
    /\ pend.k = "none" /\ primary # 0 /\ steps < MaxSteps /\ k \notin used
    /\ CASE k = "fork"   -> forking = "fork"
         [] k = "clone"  -> forking = "clone"
         [] k = "new"    -> forking = "no" /\ "New" \in Transitions
         [] k = "resume" -> forking = "no" /\ "Resume" \in Transitions
                            /\ sess[primary] # "A"
         [] k = "reload" -> forking = "no" /\ "Reload" \in Transitions
         [] k = "quit"   -> forking = "no" /\ "Quit" \in Transitions

\* The primary's session_shutdown (sync, 0 ms). stashHandoff: only a
\* shutdown whose successor reads the slot (/reload, /fork, /clone) replaces
\* it, keyed by the start reason and the successor's file (pi's
\* targetSessionFile, or the session's own file on /reload); /new, resume
\* and quit leave the slot as it is. The sidecar is saved, the scope retires
\* with pi's reason, the root is deregistered, the LSP service reset, and the
\* primary registration released (#3662: every reason but quit leaves the
\* successor pending). `quit` ends the process: in-flight work dies.
Retire(k) ==
    /\ RetireOk(k)
    /\ LET p == primary
           quit == k = "quit"
           stash == Has("handoffAtShutdown") /\ SR(k) \in SlotReasons
           succ == IF k = "reload" THEN sess[p] ELSE TargetOf(k)
           ends(t) == t = p \/ (quit /\ st[t] = "live")
       IN
       /\ st' = [t \in Tickets |-> IF ends(t) THEN "retired" ELSE st[t]]
       /\ why' = [t \in Tickets |-> IF ends(t) THEN k ELSE why[t]]
       /\ primary' = 0
       /\ slot' = IF stash
                  THEN [has |-> TRUE, from |-> p, reason |-> SR(k),
                        file |-> Key(succ), facts |-> cell[p],
                        act |-> act[p],
                        adv |-> {a.o : a \in {b \in adv : b.tag = p}}]
                  ELSE slot
       /\ side' = [side EXCEPT ![sess[p]] = cell[p]]
       /\ sideAct' = [sideAct EXCEPT ![sess[p]] = act[p]]
       /\ entry' = entry \ {p}
       /\ IF LspOn /\ Policy("LS", "shutdown") = "reset"
          THEN svc' = svc + 1 /\ fleet' = {}
          ELSE UNCHANGED <<svc, fleet>>
       /\ wr' = IF quit
                THEN [x \in FlightIds |->
                        IF wr[x].pc = "flight" THEN [wr[x] EXCEPT !.pc = "dead"]
                        ELSE wr[x]]
                ELSE wr
       /\ pend' = [k |-> k, from |-> p, file |-> sess[p], target |-> TargetOf(k)]
       /\ forking' = "no"
       /\ steps' = steps + 1
       /\ used' = used \cup {k}
    /\ UNCHANGED <<role, sess, ep, last, nxt, branch, cell, imp, lin, taken,
                   intent, reg, turn, begun, turns, procTurn, evalTurn, wgTok,
                   wgDone, lastTok, prevMax, ownDrop, recorded, resets, dupDone,
                   landed, reads, predOf, lzV, adV>>

NewFile(k) == IF k = "reload" THEN pend.file ELSE TargetOf(k)

NewBranch(k) ==
    CASE k = "fork"  -> ForkBranch(branch[pend.file])
      [] k = "clone" -> branch[pend.file]
      [] OTHER       -> branch[NewFile(k)]

NewLin(k, t) ==
    IF k \in {"fork", "clone"}
    THEN [lin EXCEPT ![NewFile(k)] = lin[pend.file] \cup {t}]
    ELSE [lin EXCEPT ![NewFile(k)] = @ \cup {t}]

\* The start's hand-off source (SOURCES in clients/session-scope.ts): the
\* first that exists wins for every store. A fork reads the slot, else the
\* parent's sidecar; a reload the slot, else its own sidecar; a resume its
\* own sidecar; /new nothing.
Src(k, match) ==
    CASE SR(k) = "fork" -> IF match THEN "slot" ELSE "parent"
      [] k = "reload"   -> IF match THEN "slot" ELSE "own"
      [] k = "resume"   -> "own"
      [] OTHER          -> "none"

\* A primary session_start of the replacement (#3668: no primary is
\* registered, and its reason is not "startup"): resetForSession begins the
\* scope, then adoptHandoff takes the slot once and runs each store's action.
Begin ==
    /\ pend.k \in {"new", "resume", "fork", "clone", "reload"}
    /\ primary = 0
    /\ LET k == pend.k
           t == nxt
           f == NewFile(k)
           nb == NewBranch(k)
           takes == IF Has("consumeOnMatch")
                    THEN SR(k) \in SlotReasons /\ SlotMatch(SR(k), f, Via(k, pend.from))
                    ELSE slot.has
           match == takes /\ SlotMatch(SR(k), f, Via(k, pend.from))
           src == Src(k, match)
           a == Policy("RG", k)
           base == IF a \in {"reset", "none"} THEN {}
                   ELSE CASE src = "slot"   -> slot.facts
                          [] src = "parent" -> side[pend.file]
                          [] src = "own"    -> side[f]
                          [] OTHER          -> {}
           kept == IF a = "carry" THEN base ELSE {x \in base : x.e \in nb}
           la == Policy("LZ", k)
           abase == IF la \in {"reset", "none"} THEN {}
                    ELSE CASE src = "slot"   -> slot.act
                           [] src = "parent" -> sideAct[pend.file]
                           [] src = "own"    -> sideAct[f]
                           [] OTHER          -> {}
           carried == IF Policy("AD", k) = "carry" /\ src = "slot"
                      THEN slot.adv ELSE {}
       IN
       /\ st' = [st EXCEPT ![t] = "live"]
       /\ role' = [role EXCEPT ![t] = "primary"]
       /\ sess' = [sess EXCEPT ![t] = f]
       /\ primary' = t /\ last' = t /\ nxt' = t + 1
       /\ branch' = [branch EXCEPT ![f] = nb]
       /\ cell' = [cell EXCEPT ![t] = kept]
       /\ imp' = [imp EXCEPT ![t] = kept]
       /\ lin' = NewLin(k, t)
       /\ slot' = IF takes THEN NoSlot ELSE slot
       /\ taken' = IF takes THEN taken \cup {[by |-> t, from |-> slot.from]}
                   ELSE taken
       /\ act' = [act EXCEPT ![t] = abase]
       /\ adv' = Retag(adv, carried, t)
       /\ reg' = IF RegOn THEN [reg EXCEPT ![t] = "queued"] ELSE reg
       /\ wgTok' = IF Policy("WG", k) = "reset" THEN 0 ELSE wgTok
       \* /reload re-evaluates the entry module when jiti's native import
       \* fails; a per-evaluation order turn restarts with it.
       /\ IF k = "reload" /\ TurnsOn
          THEN \E reEval \in BOOLEAN :
                   evalTurn' = IF reEval THEN 0 ELSE evalTurn
          ELSE UNCHANGED evalTurn
       /\ resets' = [resets EXCEPT ![t] = 1]
       /\ predOf' = [predOf EXCEPT ![t] = pend.from]
       /\ pend' = NoPend
    /\ UNCHANGED <<ep, why, forking, side, sideAct, wr, entry, intent,
                   svc, fleet, turn, begun, turns, procTurn, wgDone, lastTok,
                   prevMax, ownDrop, recorded, dupDone, landed, reads, steps,
                   used, acts, advOut, advDrop>>

\* The replacement's session_start when another start already registered as
\* primary in its gap (a subagent's own /reload or /fork, #3668 row 17): the
\* probe finds that primary's ctx live, so it is a concurrent secondary. It
\* skips handleSessionStart and adopts nothing. Under "demotedDiscard" it
\* discards the slot when the slot's key is its own (#3819 r2).
BeginDemoted ==
    /\ pend.k \in {"new", "resume", "fork", "clone", "reload"}
    /\ primary # 0
    /\ LET k == pend.k
           t == nxt
           f == NewFile(k)
       IN
       /\ st' = [st EXCEPT ![t] = "live"]
       /\ role' = [role EXCEPT ![t] = "secondary"]
       /\ sess' = [sess EXCEPT ![t] = f]
       /\ nxt' = t + 1
       /\ branch' = [branch EXCEPT ![f] = NewBranch(k)]
       /\ lin' = NewLin(k, t)
       /\ predOf' = [predOf EXCEPT ![t] = pend.from]
       /\ pend' = NoPend
       /\ slot' = IF Has("demotedDiscard")
                     /\ SlotMatch(SR(k), f, Via(k, pend.from))
                  THEN NoSlot ELSE slot
    /\ UNCHANGED <<ep, why, primary, last, forking, cell, imp, taken,
                   side, sideAct, wr, entry, intent, reg, svc, fleet, turn,
                   begun, turns, procTurn, evalTurn, wgTok, wgDone, lastTok,
                   prevMax, ownDrop, recorded, resets, dupDone, landed, reads,
                   lzV, adV, steps, used>>

\* pi --fork <path>: a new process after this one quit. The header names the
\* parent; the parent's sidecar is the only channel ("startup" reads its own
\* sidecar, which a new file lacks, then the parent's).
PiFork ==
    /\ "PiFork" \in Transitions /\ pend.k = "quit" /\ steps < MaxSteps
    /\ LET t == nxt
           src == pend.file
           nb == branch[src]
           a == Policy("RG", "piFork")
           base == IF a = "import-parent" THEN side[src] ELSE {}
       IN
       /\ st' = [st EXCEPT ![t] = "live"]
       /\ role' = [role EXCEPT ![t] = "primary"]
       /\ sess' = [sess EXCEPT ![t] = "P"]
       /\ primary' = t /\ last' = t /\ nxt' = t + 1
       /\ branch' = [branch EXCEPT !["P"] = nb]
       /\ cell' = [cell EXCEPT ![t] = {x \in base : x.e \in nb}]
       /\ imp' = [imp EXCEPT ![t] = {x \in base : x.e \in nb}]
       /\ lin' = [lin EXCEPT !["P"] = lin[src] \cup {t}]
       /\ slot' = NoSlot
       /\ act' = [act EXCEPT ![t] = IF Policy("LZ", "piFork") = "import-parent"
                                   THEN sideAct[src] ELSE {}]
       /\ adv' = {}
       /\ entry' = {} /\ intent' = 0
       /\ reg' = IF RegOn THEN [reg EXCEPT ![t] = "queued"] ELSE reg
       /\ fleet' = {}
       /\ procTurn' = 0 /\ evalTurn' = 0 /\ wgTok' = 0 /\ lastTok' = 0
       /\ prevMax' = 0
       /\ resets' = [resets EXCEPT ![t] = 1]
       /\ predOf' = [predOf EXCEPT ![t] = pend.from]
       /\ pend' = NoPend
       /\ steps' = steps + 1 /\ used' = used \cup {"piFork"}
    /\ UNCHANGED <<ep, why, forking, taken, side, sideAct, wr, svc, turn,
                   begun, turns, wgDone, ownDrop, recorded, dupDone, landed,
                   reads, acts, advOut, advDrop>>

\* /tree: the same activation. The branch loses its last entry and the scope's
\* branch epoch bumps (S1's moveBranch, from retainBranch). D7: the lazy-tool
\* activations stay.
Tree ==
    /\ "Tree" \in Transitions /\ HostOk /\ "tree" \notin used
    /\ LET p == primary
           f == sess[p]
           nb == branch[f] \ {Max(branch[f])}
           a == Policy("RG", "tree")
       IN
       /\ Cardinality(branch[f]) = 2
       /\ branch' = [branch EXCEPT ![f] = nb]
       /\ ep' = [ep EXCEPT ![p] = @ + 1]
       /\ cell' = CASE a = "filter-by-branch"
                         -> [cell EXCEPT ![p] = {x \in @ : x.e \in nb}]
                    [] a = "reset" -> [cell EXCEPT ![p] = {}]
                    [] OTHER -> cell
       /\ steps' = steps + 1 /\ used' = used \cup {"tree"}
    /\ UNCHANGED <<st, role, sess, why, primary, last, nxt, pend, forking, imp,
                   lin, slot, taken, side, sideAct, wr, entry, intent,
                   reg, svc, fleet, turn, begun, turns, procTurn, evalTurn,
                   wgTok, wgDone, lastTok, prevMax, ownDrop, recorded, resets,
                   dupDone, landed, reads, predOf, lzV, adV>>

\* The LSP idle reset: pi-lens' own timer, not a host event. It resets the
\* LSP service and nothing session-scoped (#3576).
IdleReset ==
    /\ "IdleReset" \in Transitions /\ steps < MaxSteps /\ "idle" \notin used
    /\ IF Policy("LS", "idle") = "reset"
       THEN svc' = svc + 1 /\ fleet' = {}
       ELSE UNCHANGED <<svc, fleet>>
    /\ steps' = steps + 1 /\ used' = used \cup {"idle"}
    /\ UNCHANGED <<st, role, sess, ep, why, primary, last, nxt, pend, forking,
                   branch, cell, imp, lin, slot, taken, side, sideAct, wr,
                   entry, intent, reg, turn, begun, turns, procTurn, evalTurn,
                   wgTok, wgDone, lastTok, prevMax, ownDrop, recorded, resets,
                   dupDone, landed, reads, predOf, lzV, adV>>

\* A concurrent subagent binds with reason "startup" (I6), while the primary
\* is live or in its replacement gap (#3668 declines it there). It skips
\* handleSessionStart (#473), begins its own scope and never adopts. With
\* "consumeOnMatch" it never touches the slot; without it (design section
\* 3.4 as written) its beginScope takes the slot and discards it.
SecStart ==
    /\ "SecStart" \in Transitions /\ steps < MaxSteps /\ "secStart" \notin used
    /\ pend.k # "quit"
    /\ LET t == nxt IN
       /\ st' = [st EXCEPT ![t] = "live"]
       /\ role' = [role EXCEPT ![t] = "secondary"]
       /\ sess' = [sess EXCEPT ![t] = "S"]
       /\ lin' = [lin EXCEPT !["S"] = {t}]
       /\ nxt' = t + 1
       /\ LET takes == ~Has("consumeOnMatch") /\ slot.has IN
          /\ slot' = IF takes THEN NoSlot ELSE slot
          /\ taken' = IF takes THEN taken \cup {[by |-> t, from |-> slot.from]}
                      ELSE taken
    /\ steps' = steps + 1 /\ used' = used \cup {"secStart"}
    /\ UNCHANGED <<ep, why, primary, last, pend, forking, branch, cell, imp,
                   side, sideAct, wr, entry, intent, reg, svc,
                   fleet, turn, begun, turns, procTurn, evalTurn, wgTok,
                   wgDone, lastTok, prevMax, ownDrop, recorded, resets, dupDone,
                   landed, reads, predOf, lzV, adV>>

\* A subagent's session_shutdown: its scope retires and its own cells go.
SecEnd ==
    /\ "SecEnd" \in Transitions /\ steps < MaxSteps
    /\ \E s \in Tickets :
          /\ st[s] = "live" /\ role[s] = "secondary"
          /\ st' = [st EXCEPT ![s] = "retired"]
          /\ why' = [why EXCEPT ![s] = "secEnd"]
          /\ cell' = [cell EXCEPT ![s] = {}]
    /\ steps' = steps + 1
    /\ UNCHANGED <<role, sess, ep, primary, last, nxt, pend, forking, branch,
                   imp, lin, slot, taken, side, sideAct, wr, entry,
                   intent, reg, svc, fleet, turn, begun, turns, procTurn,
                   evalTurn, wgTok, wgDone, lastTok, prevMax, ownDrop, recorded,
                   resets, dupDone, landed, reads, predOf, lzV, adV, used>>

\* A subagent's own /reload or /fork (k): its session_shutdown takes the
\* secondary path (its activation's role, #3668 I3: no stash), then its
\* successor's session_start arrives with reason k. With no primary
\* registered (the primary's replacement gap), a non-"startup" start is the
\* successor by #3668's rule and classifies primary: it runs the full start
\* and adoptHandoff with its own file. Otherwise it is a concurrent
\* secondary with fresh cells.
SecReplace(k) ==
    /\ \/ k = "reload" /\ "SecReload" \in Transitions /\ "secReload" \notin used
       \/ k = "fork" /\ "SecFork" \in Transitions /\ "secFork" \notin used
    /\ steps < MaxSteps /\ pend.k # "quit"
    /\ \E s \in Tickets :
          /\ st[s] = "live" /\ role[s] = "secondary"
          /\ LET t == nxt
                 f == IF k = "reload" THEN sess[s] ELSE "T"
                 nb == IF k = "reload" THEN branch[sess[s]]
                       ELSE ForkBranch(branch[sess[s]])
                 asPrimary == primary = 0
                 takes == asPrimary /\
                          IF Has("consumeOnMatch") THEN SlotMatch(k, f, Via(k, s))
                          ELSE slot.has
                 match == takes /\ SlotMatch(k, f, Via(k, s))
                 src == IF ~asPrimary THEN "none"
                        ELSE IF match THEN "slot"
                        ELSE IF k = "fork" THEN "parent" ELSE "own"
                 a == Policy("RG", k)
                 base == IF ~asPrimary \/ a \in {"reset", "none"} THEN {}
                         ELSE CASE src = "slot"   -> slot.facts
                                [] src = "parent" -> side[sess[s]]
                                [] src = "own"    -> side[f]
                                [] OTHER          -> {}
                 kept == IF a = "carry" THEN base ELSE {x \in base : x.e \in nb}
                 abase == IF ~asPrimary \/ Policy("LZ", k) \in {"reset", "none"}
                          THEN {}
                          ELSE CASE src = "slot"   -> slot.act
                                 [] src = "parent" -> sideAct[sess[s]]
                                 [] src = "own"    -> sideAct[f]
                                 [] OTHER          -> {}
                 carried == IF asPrimary /\ Policy("AD", k) = "carry" /\ src = "slot"
                            THEN slot.adv ELSE {}
             IN
             /\ st' = [st EXCEPT ![s] = "retired", ![t] = "live"]
             /\ why' = [why EXCEPT ![s] = k]
             /\ role' = [role EXCEPT ![t] = IF asPrimary THEN "primary"
                                             ELSE "secondary"]
             /\ sess' = [sess EXCEPT ![t] = f]
             /\ nxt' = t + 1
             /\ primary' = IF asPrimary THEN t ELSE primary
             /\ last' = IF asPrimary THEN t ELSE last
             /\ branch' = [branch EXCEPT ![f] = nb]
             /\ lin' = IF k = "fork"
                       THEN [lin EXCEPT ![f] = lin[sess[s]] \cup {t}]
                       ELSE [lin EXCEPT ![f] = @ \cup {t}]
             /\ cell' = [cell EXCEPT ![s] = {}, ![t] = kept]
             /\ imp' = [imp EXCEPT ![t] = kept]
             /\ slot' = IF takes THEN NoSlot ELSE slot
             /\ taken' = IF takes
                         THEN taken \cup {[by |-> t, from |-> slot.from]}
                         ELSE taken
             /\ act' = [act EXCEPT ![t] = abase]
             /\ adv' = Retag(adv, carried, t)
             /\ resets' = IF asPrimary THEN [resets EXCEPT ![t] = 1] ELSE resets
             /\ predOf' = [predOf EXCEPT ![t] = s]
    /\ steps' = steps + 1
    /\ used' = used \cup {IF k = "reload" THEN "secReload" ELSE "secFork"}
    /\ UNCHANGED <<ep, pend, forking, side, sideAct, wr, entry, intent, reg,
                   svc, fleet, turn, begun, turns, procTurn, evalTurn, wgTok,
                   wgDone, lastTok, prevMax, ownDrop, recorded, dupDone, landed,
                   reads, acts, advOut, advDrop>>

\* A duplicate session_start for the same replacement (I5, #2890).
Dup ==
    /\ "Dup" \in Transitions /\ HostOk /\ ~dupDone
    /\ dupDone' = TRUE
    /\ IF Has("dedupe")
       THEN UNCHANGED <<resets, cell>>
       ELSE /\ resets' = [resets EXCEPT ![primary] = @ + 1]
            /\ cell' = [cell EXCEPT ![primary] = {}]
    /\ steps' = steps + 1
    /\ UNCHANGED <<st, role, sess, ep, why, primary, last, nxt, pend, forking,
                   branch, imp, lin, slot, taken, side, sideAct, wr,
                   entry, intent, reg, svc, fleet, turn, begun, turns,
                   procTurn, evalTurn, wgTok, wgDone, lastTok, prevMax,
                   ownDrop, recorded, landed, reads, predOf, lzV, adV, used>>

-----------------------------------------------------------------------------
(* Turns and the widget's write-order guard.                               *)

TurnStart ==
    /\ turns < MaxTurns /\ primary # 0 /\ pend.k = "none"
    /\ turn' = [turn EXCEPT ![primary] = @ + 1]
    /\ begun' = [begun EXCEPT ![primary] = @ + 1]
    /\ turns' = turns + 1
    /\ Draw
    /\ UNCHANGED <<st, role, sess, ep, why, primary, last, nxt, pend, forking,
                   branch, cell, imp, lin, slot, taken, side, sideAct, wr,
                   entry, intent, reg, svc, fleet, wgTok, ownDrop, recorded,
                   resets, dupDone, landed, reads, predOf, lzV, adV, steps,
                   used>>

\* A subagent's turn_start. onTurnStart calls runtime.beginTurn() with no
\* role gate (onTurnStart in index.ts), which advances the primary's turn (N2).
SecTurn ==
    /\ "SecTurn" \in Transitions /\ turns < MaxTurns
    /\ \E s \in Tickets :
          /\ st[s] = "live" /\ role[s] = "secondary"
          /\ LET tgt == IF SecPolicy("TC") = "own" THEN s ELSE last IN
             turn' = [turn EXCEPT ![tgt] = @ + 1]
          /\ begun' = [begun EXCEPT ![s] = @ + 1]
    /\ turns' = turns + 1
    /\ Draw
    /\ UNCHANGED <<st, role, sess, ep, why, primary, last, nxt, pend, forking,
                   branch, cell, imp, lin, slot, taken, side, sideAct, wr,
                   entry, intent, reg, svc, fleet, wgTok, ownDrop, recorded,
                   resets, dupDone, landed, reads, predOf, lzV, adV, steps,
                   used>>

\* A pipeline verdict write to the widget in the current turn. The guard
\* (a clients/ module: it survives an entry re-evaluation) accepts a token
\* no older than the stored one.
WidgetWrite ==
    /\ "widget" \in Writers /\ primary # 0 /\ pend.k = "none"
    /\ begun[primary] > 0 /\ ~wgDone
    /\ wgDone' = TRUE
    /\ IF OrderNow >= wgTok
       THEN wgTok' = OrderNow /\ UNCHANGED ownDrop
       ELSE ownDrop' = TRUE /\ UNCHANGED wgTok
    /\ UNCHANGED <<st, role, sess, ep, why, primary, last, nxt, pend, forking,
                   branch, cell, imp, lin, slot, taken, side, sideAct, wr,
                   entry, intent, reg, svc, fleet, turn, begun, turns,
                   procTurn, evalTurn, lastTok, prevMax, recorded, resets,
                   dupDone, landed, reads, predOf, lzV, adV, steps, used>>

-----------------------------------------------------------------------------
(* Lazy-tool activations and the advisory queue.                           *)

\* pi_lens_activate_tools in a live scope: rememberLazyTools(scope) adds to
\* the activation's own scope cell (S2), or, shared, the primary's memory.
Activate ==
    /\ ActOn
    /\ \E t \in Tickets :
          /\ st[t] = "live" /\ t \notin acts
          /\ act' = [act EXCEPT ![ActCell(t)] = @ \cup {t}]
          /\ acts' = acts \cup {t}
    /\ UNCHANGED <<st, role, sess, ep, why, primary, last, nxt, pend, forking,
                   branch, cell, imp, lin, slot, taken, side, sideAct, wr,
                   entry, intent, reg, svc, fleet, turn, begun, turns,
                   procTurn, evalTurn, wgTok, wgDone, lastTok, prevMax,
                   ownDrop, recorded, resets, dupDone, landed, reads, predOf,
                   adV, steps, used>>

\* A context call of a live scope (consumeAgentNudge): under #3757 it prunes
\* the retired scopes' advisories and takes its own; without it, it takes
\* every queued advisory.
Context ==
    /\ AdvOn
    /\ \E t \in Tickets :
          /\ st[t] = "live"
          /\ LET mine == IF Has("advisoryScope")
                         THEN {a \in AdvLive : a.tag = t} ELSE adv
             IN
             /\ mine # {} \/ AdvPrune # {}
             /\ adv' = AdvLive \ mine
             /\ advOut' = advOut \cup {[o |-> a.o, to |-> t] : a \in mine}
             /\ advDrop' = advDrop \cup AdvPrune
    /\ UNCHANGED <<st, role, sess, ep, why, primary, last, nxt, pend, forking,
                   branch, cell, imp, lin, slot, taken, side, sideAct, wr,
                   entry, intent, reg, svc, fleet, turn, begun, turns,
                   procTurn, evalTurn, wgTok, wgDone, lastTok, prevMax,
                   ownDrop, recorded, resets, dupDone, landed, reads, predOf,
                   lzV, steps, used>>

-----------------------------------------------------------------------------
(* Writers: each begins once in a live scope and lands at any later step.   *)

\* "read": a read-guard write of the primary: a late read producer or
\* recordWritten after an await in handleToolResult, or the agent_settled
\* drain's credit (S3 fences them all by the handle captured at hook entry).
\* Uncaptured, it resolves the module-level runtime when it lands, as
\* recordWritten did before S3. "secRead": the same in a subagent.
\* "heartbeat": the registry heartbeat's repair. "lsp": LSP work that can
\* spawn a server (#3576). "advisory": the agent_end drain's lost-edit
\* notice, tagged with the drain's captured handle (#3757).
\* The entry a writer holds. A handler that has not outlived a later entry
\* holds its branch's newest one (LateHandlers = FALSE).
Held(x, s) ==
    IF x \notin {"read", "secRead"} THEN {1}
    ELSE IF LateHandlers \/ branch[sess[s]] = {} THEN branch[sess[s]]
    ELSE {Max(branch[sess[s]])}

WriterBegin(x) ==
    /\ x \in FlightIds /\ wr[x].pc = "idle"
    /\ \E s \in Tickets :
          /\ st[s] = "live"
          /\ IF x = "secRead" THEN role[s] = "secondary" ELSE s = primary
          /\ \E e \in Held(x, s) :
                wr' = [wr EXCEPT ![x] = [pc |-> "flight", s |-> s, ep |-> ep[s],
                                         e |-> e, svc |-> svc]]
    /\ UNCHANGED <<st, role, sess, ep, why, primary, last, nxt, pend, forking,
                   branch, cell, imp, lin, slot, taken, side, sideAct,
                   entry, intent, reg, svc, fleet, turn, begun, turns,
                   procTurn, evalTurn, wgTok, wgDone, lastTok, prevMax,
                   ownDrop, recorded, resets, dupDone, landed, reads, predOf,
                   lzV, adV, steps, used>>

LandRead(x) ==
    /\ x \in {"read", "secRead"} /\ x \in FlightIds /\ wr[x].pc = "flight"
    /\ LET w == wr[x]
           captured == Has("entryCapture") \/ x = "secRead"
           hs == IF captured THEN w.s ELSE last
           hep == IF captured THEN w.ep ELSE ep[last]
           f == [e |-> w.e, o |-> w.s]
           current == st[hs] = "live" /\ (Fence("RG") = "branch" => ep[hs] = hep)
           lineageCurrent == st[w.s] = "live" /\ ep[w.s] = w.ep
       IN
       /\ reads' = reads \cup {f}
       /\ IF current
          THEN /\ cell' = [cell EXCEPT ![CellOf(hs)] = @ \cup {f}]
               /\ landed' = landed \cup {f}
               /\ wr' = [wr EXCEPT ![x].pc = "landed"]
               /\ UNCHANGED <<ownDrop, recorded>>
          ELSE /\ wr' = [wr EXCEPT ![x].pc = "dropped"]
               /\ ownDrop' = (ownDrop \/ lineageCurrent)
               \* F1's record: the dropped entry is still on the branch of
               \* the writer's conversation, so a live scope may hold it.
               /\ recorded' = IF Has("recordDrop") /\ w.e \in branch[sess[w.s]]
                               THEN recorded \cup {f} ELSE recorded
               /\ UNCHANGED <<cell, landed>>
    /\ UNCHANGED <<st, role, sess, ep, why, primary, last, nxt, pend, forking,
                   branch, imp, lin, slot, taken, side, sideAct, entry, intent,
                   reg, svc, fleet, turn, begun, turns, procTurn, evalTurn,
                   wgTok, wgDone, lastTok, prevMax, resets, dupDone, predOf,
                   lzV, adV, steps, used>>

\* The heartbeat re-registers a missing root. Without a captured handle it
\* takes the root from the process-wide intent, which the new session's
\* queued registration has not yet overwritten ("heartbeat before
\* registration", the pre-#3498 shape; the lock-level detail is
\* formal/session-registry).
LandHeartbeat ==
    /\ "heartbeat" \in FlightIds /\ wr["heartbeat"].pc = "flight"
    /\ LET w == wr["heartbeat"]
           root == IF Has("entryCapture") THEN w.s ELSE intent
           ok == root # 0 /\ (Has("entryCapture") => st[w.s] = "live")
       IN
       /\ entry' = IF ok THEN entry \cup {root} ELSE entry
       /\ wr' = [wr EXCEPT !["heartbeat"].pc = IF ok THEN "landed" ELSE "dropped"]
       /\ ownDrop' = (ownDrop \/ (~ok /\ st[w.s] = "live"))
    /\ UNCHANGED <<st, role, sess, ep, why, primary, last, nxt, pend, forking,
                   branch, cell, imp, lin, slot, taken, side, sideAct,
                   intent, reg, svc, fleet, turn, begun, turns, procTurn,
                   evalTurn, wgTok, wgDone, lastTok, prevMax, recorded, resets,
                   dupDone, landed, reads, predOf, lzV, adV, steps, used>>

\* LSP work that outlived its hook calls getLSPService(). With G5's
\* captureLspServiceGeneration it stands down once the service was reset;
\* the generation is one process counter (#3755).
LandLsp ==
    /\ "lsp" \in FlightIds /\ wr["lsp"].pc = "flight"
    /\ LET w == wr["lsp"]
           g == IF Has("entryCapture") THEN w.svc ELSE svc
           ok == g = svc
       IN
       /\ fleet' = IF ok THEN fleet \cup {[g |-> w.svc, o |-> w.s]} ELSE fleet
       /\ wr' = [wr EXCEPT !["lsp"].pc = IF ok THEN "landed" ELSE "dropped"]
       /\ ownDrop' = (ownDrop \/ (~ok /\ w.svc = svc))
    /\ UNCHANGED <<st, role, sess, ep, why, primary, last, nxt, pend, forking,
                   branch, cell, imp, lin, slot, taken, side, sideAct,
                   entry, intent, reg, svc, turn, begun, turns, procTurn,
                   evalTurn, wgTok, wgDone, lastTok, prevMax, recorded, resets,
                   dupDone, landed, reads, predOf, lzV, adV, steps, used>>

\* queueAgentAdvisory(text, handle): prune the retired scopes' advisories,
\* then queue this one under the drain's captured scope, live or not (a
\* retired tag is dropped, with its record, at the next prune).
LandAdvisory ==
    /\ "advisory" \in FlightIds /\ wr["advisory"].pc = "flight"
    /\ LET w == wr["advisory"] IN
       /\ adv' = AdvLive \cup {[o |-> w.s, tag |-> w.s, late |-> st[w.s] # "live"]}
       /\ advDrop' = advDrop \cup AdvPrune
       /\ wr' = [wr EXCEPT !["advisory"].pc = "landed"]
    /\ UNCHANGED <<st, role, sess, ep, why, primary, last, nxt, pend, forking,
                   branch, cell, imp, lin, slot, taken, side, sideAct,
                   entry, intent, reg, svc, fleet, turn, begun, turns,
                   procTurn, evalTurn, wgTok, wgDone, lastTok, prevMax,
                   ownDrop, recorded, resets, dupDone, landed, reads, predOf,
                   lzV, advOut, steps, used>>

\* A queued registration lands; the #3498 generation gate drops it once its
\* session ended.
RegLand(t) ==
    /\ reg[t] = "queued"
    /\ IF st[t] = "live"
       THEN /\ entry' = entry \cup {t} /\ intent' = t
            /\ reg' = [reg EXCEPT ![t] = "done"]
       ELSE /\ reg' = [reg EXCEPT ![t] = "dropped"]
            /\ UNCHANGED <<entry, intent>>
    /\ UNCHANGED <<st, role, sess, ep, why, primary, last, nxt, pend, forking,
                   branch, cell, imp, lin, slot, taken, side, sideAct,
                   wr, svc, fleet, turn, begun, turns, procTurn,
                   evalTurn, wgTok, wgDone, lastTok, prevMax, ownDrop, recorded,
                   resets, dupDone, landed, reads, predOf, lzV, adV, steps,
                   used>>

Next ==
    \/ \E k \in {"fork", "clone"} : BeforeFork(k)
    \/ CancelFork
    \/ \E k \in {"new", "resume", "fork", "clone", "reload", "quit"} : Retire(k)
    \/ Begin
    \/ BeginDemoted
    \/ PiFork
    \/ Tree
    \/ IdleReset
    \/ SecStart
    \/ SecEnd
    \/ \E k \in {"reload", "fork"} : SecReplace(k)
    \/ Dup
    \/ TurnStart
    \/ SecTurn
    \/ WidgetWrite
    \/ Activate
    \/ Context
    \/ \E x \in FlightIds : WriterBegin(x)
    \/ \E x \in FlightIds : LandRead(x)
    \/ LandHeartbeat
    \/ LandLsp
    \/ LandAdvisory
    \/ \E t \in Tickets : RegLand(t)

Spec == Init /\ [][Next]_vars

-----------------------------------------------------------------------------
(* Invariants.                                                             *)

TypeOK ==
    /\ st \in [Tickets -> {"free", "live", "retired"}]
    /\ role \in [Tickets -> {"-", "primary", "secondary"}]
    /\ \A t \in Tickets : cell[t] \subseteq Facts
    /\ \A t \in Tickets : act[t] \subseteq Tickets
    /\ primary \in 0..(MaxSteps + 2)
    /\ slot.reason \in {"-"} \cup SlotReasons
    /\ \A s \in Stores : \A r \in Reasons : Policy(s, r) \in Actions

\* The design's NoCrossScopeWrite (#3528, #3568, #3596, #3576): a live
\* scope's read-guard cell holds only its own facts and the facts it
\* inherited; the registry entry holds only live roots (the #3498 ghost
\* root); every LSP server belongs to the current service generation.
NoCrossSessionState ==
    /\ \A t \in Tickets :
          st[t] = "live" => \A x \in cell[t] : x.o = t \/ x \in imp[t]
    /\ \A r \in entry : st[r] = "live"
    /\ \A srv \in fleet : srv.g = svc

\* The design's NoOffBranchFact (#3521): a live scope's own-lineage facts
\* name entries on its current branch.
NoStaleBranchWrite ==
    \A t \in Tickets :
        st[t] = "live" =>
            \A x \in cell[t] : x.o \in lin[sess[t]] => x.e \in branch[sess[t]]

\* The design's NoLostCarry (shape 54): every fact that reached a cell of the
\* live scope's lineage, on an entry its conversation still holds, is in the
\* cell it reads.
NoLostCarry ==
    \A t \in Tickets :
        st[t] = "live" =>
            \A x \in landed :
                (x.o \in lin[sess[t]] /\ x.e \in branch[sess[t]])
                    => x.e \in Ents(cell[CellOf(t)])

\* The same over every read-guard write that COMPLETED, whether it reached a
\* cell or a guard dropped it: a read whose tool result is in the live
\* conversation authorises an edit there. A violation is a false block. The
\* design accepts it (F1); the AcceptedLateRead* configs pin where it occurs.
NoFalseBlock ==
    \A t \in Tickets :
        st[t] = "live" =>
            \A x \in reads :
                (x.o \in lin[sess[t]] /\ x.e \in branch[sess[t]])
                    => x.e \in Ents(cell[CellOf(t)])

\* F1's decision: every false block left a degradation record.
NoUnrecordedFalseBlock ==
    \A t \in Tickets :
        st[t] = "live" =>
            \A x \in reads \ recorded :
                (x.o \in lin[sess[t]] /\ x.e \in branch[sess[t]])
                    => x.e \in Ents(cell[CellOf(t)])

\* No guard drops a write whose own lineage is still current (shape 54).
NoOwnDrop == ~ownDrop

\* #3607 and N2: a primary transition never removes a live secondary's own
\* facts, and a secondary's turn never moves a primary's turn.
SecondaryIsolation ==
    /\ \A s \in Tickets :
          (st[s] = "live" /\ role[s] = "secondary")
              => {x \in landed : x.o = s} \subseteq cell[CellOf(s)]
    /\ \A p \in Tickets :
          (st[p] = "live" /\ role[p] = "primary") => turn[p] = begun[p]

\* F2: the slot is taken only by a primary start that replaced the scope
\* that wrote it.
HandoffOnce ==
    \A x \in taken : role[x.by] = "primary" /\ predOf[x.by] = x.from

\* Hypothesis 3 (#3803): a slot is taken only by a start whose conversation
\* continues the writer's (the same file on /reload, a copy on /fork), so no
\* start adopts another session's state through the slot.
NoCrossSessionAdoption ==
    \A x \in taken : x.from \in lin[sess[x.by]]

\* #3540 case A, N3: a token drawn later outranks every earlier one, across
\* /reload and entry-module evaluations.
OrderMonotone == lastTok = 0 \/ prevMax < lastTok

\* #2890: one session_start mutation pass per scope.
OneResetPerScope == \A t \in Tickets : resets[t] <= 1

\* A live scope's cell holds only facts of its own conversation lineage, on
\* its current branch (proposed in the S9 review). The invariants above take
\* `x.o \in lin[...]` as a premise, so a lineage truth that omits a scope
\* makes them vacuous for its facts: a /fork that does not copy its parent's
\* lineage passes every other invariant of Fix, and violates this one.
NoForeignFact ==
    \A t \in Tickets :
        st[t] = "live" =>
            \A x \in cell[t] : x.o \in lin[sess[t]] /\ x.e \in branch[sess[t]]

\* #3604, #3653: a live scope holds only activations of its conversation.
NoForeignActivation ==
    \A t \in Tickets : st[t] = "live" => act[t] \subseteq lin[sess[t]]

\* #3604: a live scope holds every activation its conversation made
\* (/tree keeps them, D7; /new starts a conversation of its own). A demoted
\* real successor is a secondary, so the check covers every role.
NoLostActivation ==
    \A t \in Tickets :
        st[t] = "live" =>
            \A o \in acts : o \in lin[sess[t]] => o \in act[t]

\* #3748: an advisory reaches only a context call of its own conversation.
NoCrossSessionDelivery ==
    \A d \in advOut : d.o \in lin[sess[d.to]]

\* S2 (#3612): an advisory still queued when its scope retired by /reload is
\* not lost: once the successor started, it is queued again, and so is
\* later delivered, still queued, or dropped for another reason (a later
\* /new). One queued after its scope retired (late) is an accepted,
\* recorded drop.
NoLostAdvisory ==
    pend.k # "reload" =>
        \A d \in advDrop :
            (d.why = "reload" /\ ~d.late)
                => \/ \E a \in adv : a.o = d.o
                   \/ \E x \in advOut : x.o = d.o
                   \/ \E d2 \in advDrop : d2.o = d.o /\ (d2.why # "reload" \/ d2.late)

=============================================================================
