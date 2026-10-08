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
(*   subagent /reload, /fork, /new: its own replacement, a shutdown and a  *)
(*       later start (SecDown, SecUp). In the primary's replacement gap a  *)
(*       start with a reason other than "startup" was classified primary   *)
(*       (#3668 row 17); #3855 r2 admits only the named successor.         *)
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
(*   "forwardUnadopted"  #3881: a primary shutdown that lands while its    *)
(*                       own start is in flight, before adoptHandoff,      *)
(*                       re-keys the slot left for that start to its own   *)
(*                       /reload and stashes nothing of its scope;         *)
(*                       without it, it stashes the scope's empty snapshot *)
(*   "forwardPolicy"     #3881 r2: the forwarded slot keeps only the       *)
(*                       stores its own start's reason adopts; without it, *)
(*                       every store, so the successor's /reload policy    *)
(*                       carries a /fork start's advisory (AD fork: none)  *)
(*   "inheritRole"       #3855 r1: a secondary's replacement shutdown      *)
(*                       leaves a note keyed by its successor's hand-off   *)
(*                       key; the start that finds its note stays          *)
(*                       secondary, and so does a primary successor whose  *)
(*                       key a note holds. An in-memory /new leaves none   *)
(*                       (R1); a note can be evicted, or go stale          *)
(*   "namedSuccessor"    #3855 r2: a primary replacement shutdown names    *)
(*                       its successor by (reason, key); in the gap only   *)
(*                       that start is primary, and the real successor     *)
(*                       (Begin) is declined if its own key differs.       *)
(*                       Without either, any non-startup gap start is      *)
(*                       primary (#3668 row 17)                            *)
(*   "rolelessKey"       #4106: a shutdown whose start never ran, in a     *)
(*                       named gap, is the primary's only when its own     *)
(*                       manager's key is the named one (SecRoleless)      *)
(*   "forwardUnstarted"  #4113: a shutdown that lands before pi-lens's     *)
(*                       start handler ran (W0: no mark, no scope) forwards *)
(*                       the slot left for the start its gap names, as     *)
(*                       forwardUnadopted does; without it nothing is      *)
(*                       written and the slot keeps the start's reason     *)
(*   "nameAtShutdown"    #3855 r5 (merged): the naming site binds a fresh  *)
(*                       ticket to a file-less reload/fork session's       *)
(*                       manager that carries none, in every window        *)
(*   "bindInterrupted"   #3855 r4: a forward binds the interrupted scope's *)
(*                       ticket when its manager carries none (an in-memory*)
(*                       /new or startup), so no reload gap is named by no *)
(*                       key                                               *)
(*   "keylessFailSafe"   #3855 r2's J6, a rejected alternative: a key-less *)
(*                       gap start with the named reason passes for a      *)
(*                       ticket name                                       *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS
    Transitions,    \* the host transitions this config enables, a subset of
                    \*   {"New","Resume","Fork","Clone","CancelFork","Reload",
                    \*    "Quit","PiFork","Tree","IdleReset","SecStart",
                    \*    "SecEnd","SecTurn","SecReload","SecFork","Dup",
                    \*    "Interrupt","InterruptPreScope","InterruptUnstarted"}
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

\* Merged master: S2 gave the lazy-tool memory a cell per scope (#3653), and
\* #3613 the turn state: `beginTurn` takes the turn's session id and the
\* per-turn records are partitioned by it (`clients/runtime-coordinator.ts`).
\* A subagent's handlers still reach the module-level runtime's read guard
\* (#3607, F4, the rest of #3613).
MergedSec(s) == IF s \in {"LZ", "TC"} THEN "own" ELSE "shared"

\* Merged master before #3613: the turn counter and per-turn maps were the
\* module-level runtime's too (N2).
PreS4TurnSec(s) == IF s = "LZ" THEN "own" ELSE "shared"

\* Before S2, the subagent shared everything.
LegacySec(s) == "shared"

-----------------------------------------------------------------------------
(* The world.                                                              *)

Tickets == 1..(MaxSteps + 2)
Files   == {"A", "N", "F", "C", "P", "S", "T", "U"}
                                \* initial, /new, /fork, /clone, pi --fork,
                                \* the subagent's, its fork, its /new
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

\* `from` is the scope that wrote the slot (HandoffOnce); `tk` is the ticket
\* a file-less slot is keyed by (#3819), which a forward keeps (#3881).
NoSlot == [has |-> FALSE, from |-> 0, tk |-> 0, reason |-> "-", file |-> "-",
           facts |-> {}, act |-> {}, adv |-> {}]
\* A hand-off key (startKey): a session file, or, file-less, the ticket bound
\* to the session manager; NoKey when pi links nothing.
NoKey  == [f |-> "-", t |-> 0]
NoPend == [k |-> "none", from |-> 0, file |-> "-", target |-> "-", key |-> NoKey]
NoSpend == [k |-> "none", from |-> 0, file |-> "-", key |-> NoKey]

\* #3855 r2 (successorStartKey): the key a primary shutdown of scope p names
\* for its successor on file succ. pi names the file of a file-backed
\* successor, and hands a /reload or in-memory /fork successor the same
\* manager, so p's ticket; an in-memory /new is linked to nothing.
NamedKey(k, p, succ) ==
    IF succ \notin FileLess THEN [f |-> succ, t |-> 0]
    ELSE IF SR(k) \in SlotReasons THEN [f |-> "-", t |-> p] ELSE NoKey
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
    steps, used,
    notes,                   \* #3855 r1: secondary-successor notes (keys)
    spend,                   \* a subagent replacement between its shutdown and start
    subBorn,                 \* ghost: scopes of the subagent's chain
    userDeclined,            \* ghost: a user scope's own replacement start was
                             \* declined while no scope held the primary slot
    fwd,                     \* scopes whose start a /reload interrupted (#3881):
                             \* their shutdown forwarded, it stashed nothing
    preScope                 \* of those, the ones interrupted before the start
                             \* held its scope (verify r4 V6: W0-W2)

vars == <<st, role, sess, ep, why, primary, last, nxt, pend, forking, branch,
          cell, imp, lin, slot, taken, side, sideAct, wr, entry, intent, reg,
          svc, fleet, turn, begun, turns, procTurn, evalTurn, wgTok, wgDone,
          lastTok, prevMax, ownDrop, recorded, resets, dupDone, landed, reads,
          predOf, act, acts, adv, advOut, advDrop, steps, used, notes, spend,
          subBorn, userDeclined, fwd, preScope>>

\* Groups for UNCHANGED.
lzV  == <<act, acts>>
adV  == <<adv, advOut, advDrop>>
r2V  == <<notes, spend, subBorn, userDeclined, fwd, preScope>>

\* The successor born from scope p is of the subagent's chain when p is.
Born(t, p) == IF p \in subBorn THEN subBorn \cup {t} ELSE subBorn

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
    /\ notes = {} /\ spend = NoSpend /\ subBorn = {} /\ userDeclined = FALSE
    /\ fwd = {} /\ preScope = {}

-----------------------------------------------------------------------------
(* Helpers.                                                                *)

\* The cell a write of scope t reaches: its own, or, when the store is
\* shared with secondaries, the one the module-level runtime serves.
CellOf(t) == IF role[t] = "secondary" /\ SecPolicy("RG") = "shared"
             THEN last ELSE t
ActCell(t) == IF role[t] = "secondary" /\ SecPolicy("LZ") = "shared"
              THEN last ELSE t
\* The scope whose turn counter and per-turn maps a turn of scope t should
\* move: its own, or, when the turn state is shared, the module-level
\* runtime's.
TurnCellOf(t) == IF role[t] = "secondary" /\ SecPolicy("TC") = "shared"
                 THEN last ELSE t
\* #3613 F1: the coordinator holds the stable id of the session it serves.
\* The start pins it; `startThrows` is a start whose handler throws after its
\* reset, which skips a pin placed after the start's await, so the
\* coordinator keeps the reset's random id. `pinAtReset` pins it before the
\* await (merged).
Pinned == ~Has("startThrows") \/ Has("pinAtReset")
\* The code's rule (`turnSession`, `beginTurn`): a turn is the coordinator's
\* own when its session's id equals the id the coordinator holds. Selected by
\* id, not by role, like the code.
OwnTurn(t) == Pinned /\ sess[t] = sess[last]

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
\* The manager of interrupted scope s, carrying no ticket, gets one: r5 at
\* the naming site (always); r4 in the forward, only once the start held its
\* scope.
Bound(s) == Has("nameAtShutdown")
            \/ (Has("bindInterrupted") /\ s \notin preScope)

\* A forwarded scope (#3881) stashed nothing: its manager carries the ticket
\* its own start's manager carried, its predecessor's when that start kept
\* the manager, else, under "bindInterrupted" (#3855 r4), its own.
RECURSIVE Carrier(_)
Carrier(s) ==
    IF s = 0 THEN 0
    ELSE IF s \in fwd
         THEN LET c == IF SameMgr(s) THEN Carrier(predOf[s]) ELSE 0
              IN IF c = 0 /\ Bound(s) THEN s ELSE c
    ELSE IF role[s] = "primary" /\ Has("handoffAtShutdown")
            /\ why[s] \in {"reload", "fork", "clone"} THEN s
    ELSE IF SameMgr(s) THEN Carrier(predOf[s])
    ELSE 0

\* The ticket a start replacing scope s with reason k finds bound to the
\* manager pi hands it (only a manager-keeping transition inherits one).
Via(k, s) == IF k \in {"reload", "fork", "clone"} THEN Carrier(s) ELSE 0

\* takeHandoff (clients/session-scope.ts): the slot's key equals the start's
\* (start reason, session file). A file-less session's file is undefined;
\* under "ticketKey" its key is the ticket that left the slot (slot.tk),
\* and the start's is c, the ticket bound to its manager (Via).
SlotMatch(r, f, c) ==
    /\ slot.has /\ slot.reason = r /\ slot.file = Key(f)
    /\ (Has("ticketKey") /\ f \in FileLess) => slot.tk = c

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
               ELSE [has |-> TRUE, from |-> primary, tk |-> primary, reason |-> "fork",
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
RetireTo(k, tgt, tag) ==
    /\ LET p == primary
           quit == k = "quit"
           stash == Has("handoffAtShutdown") /\ SR(k) \in SlotReasons
           succ == IF k = "reload" THEN sess[p] ELSE tgt
           ends(t) == t = p \/ (quit /\ st[t] = "live")
       IN
       /\ st' = [t \in Tickets |-> IF ends(t) THEN "retired" ELSE st[t]]
       /\ why' = [t \in Tickets |-> IF ends(t) THEN k ELSE why[t]]
       /\ primary' = 0
       /\ slot' = IF stash
                  THEN [has |-> TRUE, from |-> p, tk |-> p, reason |-> SR(k),
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
       /\ pend' = [k |-> k, from |-> p, file |-> sess[p], target |-> tgt,
                    key |-> NamedKey(k, p, succ)]
       /\ forking' = "no"
       /\ steps' = steps + 1
       /\ used' = used \cup {tag}
    /\ UNCHANGED <<role, sess, ep, last, nxt, branch, cell, imp, lin, taken,
                   intent, reg, turn, begun, turns, procTurn, evalTurn, wgTok,
                   wgDone, lastTok, prevMax, ownDrop, recorded, resets, dupDone,
                   landed, reads, predOf, lzV, adV>>

Retire(k) == RetireOk(k) /\ RetireTo(k, TargetOf(k), k)

\* #3855 F3 (review probe PR7): the primary resumes the subagent's session
\* file once no live scope serves it.
RetireSub ==
    /\ "ResumeSub" \in Transitions /\ "resumeSub" \notin used
    /\ pend.k = "none" /\ primary # 0 /\ steps < MaxSteps /\ forking = "no"
    /\ lin["S"] # {} /\ sess[primary] # "S"
    /\ \A t \in Tickets : ~(st[t] = "live" /\ sess[t] = "S")
    /\ RetireTo("resume", "S", "resumeSub")

NewFile(k) == IF k = "reload" THEN pend.file ELSE pend.target

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
\* #3855 r1: the real successor's key is in a note (a stale one, F3), so its
\* start is declined as a secondary's successor.
R1Declines == Has("inheritRole") /\ ~Has("namedSuccessor")
              /\ pend.key # NoKey /\ pend.key \in notes

\* #3855 r2 (verify V2): the key the real successor's own start computes
\* (startKey), derived from its side, independently of NamedKey: its file,
\* else the ticket bound to the manager pi hands a /reload or in-memory
\* /fork successor (Via, #3819's Carrier), else none.
BeginKey ==
    LET f == NewFile(pend.k) IN
    IF f \notin FileLess THEN [f |-> f, t |-> 0]
    ELSE IF SR(pend.k) \in SlotReasons
         THEN [f |-> "-", t |-> Via(pend.k, pend.from)] ELSE NoKey

\* The named pair admits a start key (keylessFailSafe: round 2's J6).
Admits(key) == key = pend.key
               \/ (Has("keylessFailSafe") /\ key = NoKey /\ pend.key.t # 0)

\* The real successor's start is declined: round 1's stale note, or, under
\* #3855 r2, its own key is not the one its predecessor's shutdown named.
Declines == R1Declines \/ (Has("namedSuccessor") /\ ~Admits(BeginKey))

Begin ==
    /\ pend.k \in {"new", "resume", "fork", "clone", "reload"}
    /\ primary = 0
    /\ ~Declines
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
       /\ subBorn' = Born(t, pend.from)
    /\ UNCHANGED <<ep, why, forking, side, sideAct, wr, entry, intent,
                   svc, fleet, turn, begun, turns, procTurn, wgDone, lastTok,
                   prevMax, ownDrop, recorded, dupDone, landed, reads, steps,
                   used, acts, advOut, advDrop, notes, spend, userDeclined, fwd, preScope>>

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
       /\ subBorn' = Born(t, pend.from)
    /\ UNCHANGED <<ep, why, primary, last, forking, cell, imp, taken,
                   side, sideAct, wr, entry, intent, reg, svc, fleet, turn,
                   begun, turns, procTurn, evalTurn, wgTok, wgDone, lastTok,
                   prevMax, ownDrop, recorded, resets, dupDone, landed, reads,
                   lzV, adV, steps, used, notes, spend, userDeclined, fwd, preScope>>

\* #3855 r1 F3: the real successor's start, with no primary registered,
\* finds its own key in a (stale) secondary note and is declined as that
\* secondary's successor; it consumes the note and the process is left with
\* no primary. Under "demotedDiscard" it discards the slot left for it.
BeginDeclined ==
    /\ pend.k \in {"new", "resume", "fork", "clone", "reload"}
    /\ primary = 0 /\ Declines
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
       /\ notes' = notes \ {BeginKey}
       /\ subBorn' = Born(t, pend.from)
    /\ UNCHANGED <<ep, why, primary, last, forking, cell, imp, taken,
                   side, sideAct, wr, entry, intent, reg, svc, fleet, turn,
                   begun, turns, procTurn, evalTurn, wgTok, wgDone, lastTok,
                   prevMax, ownDrop, recorded, resets, dupDone, landed, reads,
                   lzV, adV, steps, used, spend, userDeclined, fwd, preScope>>

\* #3881: the replacement's primary session_start begins (resetForSession
\* draws its ticket; the module-level runtime serves it) and, before
\* adoptHandoff, the activation's own /reload shutdown lands: a handler
\* ordered before pi-lens scheduled AgentSession.reload(), which pi does not
\* stop while it awaits the start's emit. One step: the start never adopts
\* (the code returns before adoptHandoff once its shutdown ran) and never
\* registers. Its shutdown saves no sidecar either way: the coordinator's
\* session id is not pinned yet (persistScope's hasStableSessionId gate).
\* Under "forwardUnadopted" it re-keys the slot left for the start to its
\* own /reload (forwardHandoff); without it, it stashes the empty scope.
\* Registry and LSP writers are out of scope for this step.
\* forwardHandoff's store filter: a store stays in the forwarded slot when
\* the interrupted start's reason k adopts it (the model's adopt rows are
\* every action but reset and none).
Keeps(s, k) == ~Has("forwardPolicy") \/ Policy(s, k) \notin {"reset", "none"}

\* w = "pre": the reload lands before the start held its scope (verify r4
\* V6), inside its awaits before `scope = runtime.sessionScope` (W1, W2).
\* w = "unstarted" (#4113): before pi-lens's start handler ran (W0), so there
\* is no in-flight mark either; the shutdown is primary by the gap's named
\* key (#4106), and the name is the start reason pi-lens never saw. Nothing
\* was reset yet in either, and only the naming-site rule can bind a ticket
\* to the start's manager.
InterruptAt(w) ==
    /\ \/ w = "post" /\ "Interrupt" \in Transitions
       \/ w = "pre" /\ "InterruptPreScope" \in Transitions
       \/ w = "unstarted" /\ "InterruptUnstarted" \in Transitions
    /\ "interrupt" \notin used
    /\ ~RegOn /\ ~LspOn
    /\ pend.k \in {"new", "resume", "fork", "clone", "reload"}
    /\ primary = 0 /\ steps < MaxSteps
    /\ LET k == pend.k
           t == nxt
           f == NewFile(k)
           pre == w # "post"
           \* The code's forward: the in-flight mark's reason, or at W0 the
           \* gap's name (pend.k either way).
           fwdOn == Has("forwardUnadopted")
                    /\ (w # "unstarted" \/ Has("forwardUnstarted"))
           left == SR(k) \in SlotReasons /\ SlotMatch(SR(k), f, Via(k, pend.from))
           \* SameMgr for t: its start kept pend.from's manager.
           keeps == k \in {"reload", "fork", "clone"} /\ (k = "reload" \/ f \in FileLess)
           kept == IF keeps THEN Carrier(pend.from) ELSE 0
           bound == Has("nameAtShutdown") \/ (Has("bindInterrupted") /\ ~pre)
           tick == IF ~Has("forwardUnadopted") THEN t
                   ELSE IF kept # 0 THEN kept
                   ELSE IF bound THEN t ELSE 0
           ikey == IF f \notin FileLess THEN [f |-> f, t |-> 0]
                   ELSE IF tick = 0 THEN NoKey ELSE [f |-> "-", t |-> tick]
       IN
       /\ st' = [st EXCEPT ![t] = "retired"]
       /\ role' = [role EXCEPT ![t] = "primary"]
       /\ sess' = [sess EXCEPT ![t] = f]
       /\ why' = [why EXCEPT ![t] = "reload"]
       /\ last' = t /\ nxt' = t + 1
       /\ branch' = [branch EXCEPT ![f] = NewBranch(k)]
       /\ lin' = NewLin(k, t)
       /\ predOf' = [predOf EXCEPT ![t] = pend.from]
       /\ resets' = IF pre THEN resets ELSE [resets EXCEPT ![t] = 1]
       /\ slot' = IF fwdOn
                  THEN IF left
                       THEN [slot EXCEPT !.from = t, !.reason = "reload",
                                         !.file = Key(f),
                                         !.facts = IF Keeps("RG", k) THEN @ ELSE {},
                                         !.act = IF Keeps("LZ", k) THEN @ ELSE {},
                                         !.adv = IF Keeps("AD", k) THEN @ ELSE {}]
                       ELSE slot
                  \* W0 without the fix: no mark and no scope, nothing written.
                  ELSE IF w = "unstarted" THEN slot
                  ELSE [has |-> TRUE, from |-> t, tk |-> t, reason |-> "reload",
                        file |-> Key(f), facts |-> {}, act |-> {}, adv |-> {}]
       \* #3855 r4 (verify r3 V4): the gap is named by the key the code's
       \* successorStartKey reads after the forward: the ticket on the
       \* interrupted start's manager (ikey).
       /\ pend' = [k |-> "reload", from |-> t, file |-> f, target |-> "-",
                    key |-> ikey]
       /\ subBorn' = Born(t, pend.from)
       /\ fwd' = IF Has("forwardUnadopted") THEN fwd \cup {t} ELSE fwd
       /\ preScope' = IF pre THEN preScope \cup {t} ELSE preScope
       /\ steps' = steps + 1
       /\ used' = used \cup {"interrupt"}
    /\ UNCHANGED <<ep, primary, forking, cell, imp, taken, side, sideAct, wr,
                   entry, intent, reg, svc, fleet, turn, begun, turns,
                   procTurn, evalTurn, wgTok, wgDone, lastTok, prevMax,
                   ownDrop, recorded, dupDone, landed, reads, lzV, adV,
                   notes, spend, userDeclined>>

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
       /\ subBorn' = Born(t, pend.from)
       /\ steps' = steps + 1 /\ used' = used \cup {"piFork"}
    /\ UNCHANGED <<ep, why, forking, taken, side, sideAct, wr, svc, turn,
                   begun, turns, wgDone, ownDrop, recorded, dupDone, landed,
                   reads, acts, advOut, advDrop, notes, spend, userDeclined, fwd, preScope>>

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
       /\ subBorn' = subBorn \cup {t}
       /\ LET takes == ~Has("consumeOnMatch") /\ slot.has IN
          /\ slot' = IF takes THEN NoSlot ELSE slot
          /\ taken' = IF takes THEN taken \cup {[by |-> t, from |-> slot.from]}
                      ELSE taken
    /\ steps' = steps + 1 /\ used' = used \cup {"secStart"}
    /\ UNCHANGED <<ep, why, primary, last, pend, forking, branch, cell, imp,
                   side, sideAct, wr, entry, intent, reg, svc,
                   fleet, turn, begun, turns, procTurn, evalTurn, wgTok,
                   wgDone, lastTok, prevMax, ownDrop, recorded, resets, dupDone,
                   landed, reads, predOf, lzV, adV, notes, spend, userDeclined, fwd, preScope>>

\* #3855 verify r2 (probe PR8): an SDK subagent's FIRST bind with a
\* replacement reason (createAgentSessionFromServices({ sessionStartEvent }),
\* pi sdk.js), in memory unless file S is file-backed. No shutdown precedes
\* it. In the primary's gap #3668 took it for the successor; #3855 r2 admits
\* it only on the named pair. It never adopts (a fresh session's sources hold
\* nothing of the primary's).
SecBind(k) ==
    /\ "SecBindReplace" \in Transitions /\ steps < MaxSteps
    /\ "secStart" \notin used /\ pend.k # "quit"
    /\ LET t == nxt
           key == IF "S" \in FileLess THEN NoKey ELSE [f |-> "S", t |-> 0]
           asPrimary ==
               /\ primary = 0
               /\ IF Has("namedSuccessor")
                  THEN pend.k \in {"new", "resume", "fork", "clone", "reload"}
                       /\ SR(pend.k) = k /\ Admits(key)
                  ELSE TRUE
       IN
       /\ st' = [st EXCEPT ![t] = "live"]
       /\ role' = [role EXCEPT ![t] = IF asPrimary THEN "primary" ELSE "secondary"]
       /\ sess' = [sess EXCEPT ![t] = "S"]
       /\ lin' = [lin EXCEPT !["S"] = {t}]
       /\ nxt' = t + 1
       /\ primary' = IF asPrimary THEN t ELSE primary
       /\ last' = IF asPrimary THEN t ELSE last
       /\ resets' = IF asPrimary THEN [resets EXCEPT ![t] = 1] ELSE resets
       /\ subBorn' = subBorn \cup {t}
    /\ steps' = steps + 1 /\ used' = used \cup {"secStart"}
    /\ UNCHANGED <<ep, why, pend, forking, branch, cell, imp, slot, taken,
                   side, sideAct, wr, entry, intent, reg, svc, fleet, turn,
                   begun, turns, procTurn, evalTurn, wgTok, wgDone, lastTok,
                   prevMax, ownDrop, recorded, dupDone, landed, reads, predOf,
                   lzV, adV, notes, spend, userDeclined, fwd, preScope>>

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

\* A subagent's own /reload, /fork or /new (k), in two steps, because pi
\* awaits the shutdown's handlers before it builds the successor: anything,
\* the primary's own replacement included, can land between them.
\*
\* SecDown: its session_shutdown takes the secondary path (its activation's
\* role, #3668 I3: no stash). Under "inheritRole" (#3855 r1) it leaves a
\* note keyed by its successor's hand-off key: the successor's file, else
\* (a /reload or in-memory /fork, which keep pi's manager) its ticket. An
\* in-memory /new is linked to nothing and leaves no note (R1). The start may
\* never come (pi's reload() emits no session_start to a session without host
\* bindings), and the note then stays (F3).
SecDown(k) ==
    /\ \/ k = "reload" /\ "SecReload" \in Transitions /\ "secReload" \notin used
       \/ k = "fork" /\ "SecFork" \in Transitions /\ "secFork" \notin used
       \/ k = "new" /\ "SecNew" \in Transitions /\ "secNew" \notin used
    /\ steps < MaxSteps /\ pend.k # "quit" /\ spend.k = "none"
    /\ \E s \in Tickets :
          /\ st[s] = "live" /\ role[s] = "secondary"
          /\ LET f == CASE k = "reload" -> sess[s] [] k = "fork" -> "T"
                         [] OTHER -> "U"
                 \* Only round 1 binds a secondary's manager (its note's
                 \* ticket); under #3855 r2 nothing does, so a file-less
                 \* subagent successor carries no key.
                 key == IF f \notin FileLess THEN [f |-> f, t |-> 0]
                        ELSE IF Has("inheritRole") /\ ~Has("namedSuccessor")
                                /\ k \in {"reload", "fork"}
                             THEN [f |-> "-", t |-> s] ELSE NoKey
                 noted == Has("inheritRole") /\ ~Has("namedSuccessor")
                          /\ key # NoKey
             IN
             /\ st' = [st EXCEPT ![s] = "retired"]
             /\ why' = [why EXCEPT ![s] = k]
             /\ cell' = [cell EXCEPT ![s] = {}]
             /\ notes' = IF noted THEN notes \cup {key} ELSE notes
             /\ spend' = [k |-> k, from |-> s, file |-> f, key |-> key]
    /\ steps' = steps + 1
    /\ used' = used \cup {CASE k = "reload" -> "secReload"
                              [] k = "fork" -> "secFork" [] OTHER -> "secNew"}
    /\ UNCHANGED <<role, sess, ep, primary, last, nxt, pend, forking, branch,
                   imp, lin, slot, taken, side, sideAct, wr, entry, intent,
                   reg, svc, fleet, turn, begun, turns, procTurn, evalTurn,
                   wgTok, wgDone, lastTok, prevMax, ownDrop, recorded, resets,
                   dupDone, landed, reads, predOf, lzV, adV, subBorn,
                   userDeclined, fwd, preScope>>

\* SecUp: the successor's session_start, reason k. With no primary
\* registered (the primary's replacement gap):
\*   - neither part (#3668 row 17): a non-"startup" start is primary;
\*   - "inheritRole" (#3855 r1): primary unless its note is still there;
\*   - "namedSuccessor" (#3855 r2): primary only when its (reason, key) is
\*     the pair the primary's shutdown named.
\* A primary start runs the full start and adoptHandoff with its own file;
\* a secondary start has fresh cells and never adopts.
SecUp ==
    /\ spend.k # "none"
    /\ LET k == spend.k
           s == spend.from
           t == nxt
           f == spend.file
           gap == primary = 0
           asPrimary ==
               /\ gap
               /\ CASE Has("namedSuccessor") ->
                        pend.k \in {"new", "resume", "fork", "clone", "reload"}
                        /\ SR(pend.k) = k /\ Admits(spend.key)
                    [] Has("inheritRole") -> spend.key \notin notes
                    [] OTHER -> TRUE
           nb == CASE k = "reload" -> branch[sess[s]]
                   [] k = "fork" -> ForkBranch(branch[sess[s]])
                   [] OTHER -> branch[f]
           takes == asPrimary /\
                    IF Has("consumeOnMatch") THEN SlotMatch(k, f, Via(k, s))
                    ELSE slot.has
           match == takes /\ SlotMatch(k, f, Via(k, s))
           src == IF ~asPrimary \/ k = "new" THEN "none"
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
       /\ st' = [st EXCEPT ![t] = "live"]
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
       /\ cell' = [cell EXCEPT ![t] = kept]
       /\ imp' = [imp EXCEPT ![t] = kept]
       /\ slot' = IF takes THEN NoSlot ELSE slot
       /\ taken' = IF takes
                   THEN taken \cup {[by |-> t, from |-> slot.from]}
                   ELSE taken
       /\ act' = [act EXCEPT ![t] = abase]
       /\ adv' = Retag(adv, carried, t)
       /\ resets' = IF asPrimary THEN [resets EXCEPT ![t] = 1] ELSE resets
       /\ predOf' = [predOf EXCEPT ![t] = s]
       /\ notes' = notes \ {spend.key}
       /\ spend' = NoSpend
       /\ subBorn' = Born(t, s)
       /\ userDeclined' = (userDeclined \/ (gap /\ ~asPrimary /\ s \notin subBorn))
    /\ UNCHANGED <<ep, why, pend, forking, side, sideAct, wr, entry, intent,
                   reg, svc, fleet, turn, begun, turns, procTurn, evalTurn,
                   wgTok, wgDone, lastTok, prevMax, ownDrop, recorded, dupDone,
                   landed, reads, acts, advOut, advDrop, steps, used, fwd, preScope>>

\* #4106 (V7 of #3855): the gap subagent's own /new start (SecDown(new) done,
\* its SecUp not yet) is interrupted by its own /reload before pi-lens's start
\* handler ran (micro:0), so that activation t shuts down with no recorded
\* role, in the primary's gap (no primary registered). Without "rolelessKey"
\* it fails safe to primary: it names the gap by a fresh ticket on its own
\* manager, and its reload successor t2 matches that name and is primary, so
\* the real successor is demoted later (BeginDemoted). With it, the shutdown
\* is the primary's only when its own key (its file, else none: nothing bound
\* its new manager) is the named key; otherwise it is a secondary's, the gap
\* keeps its name, and t2 (reload, its key) is declined. A key of none in a
\* gap named (new, none) still matches: residual R3.
SecRoleless ==
    /\ "SecRoleless" \in Transitions /\ "secRoleless" \notin used
    /\ steps < MaxSteps
    /\ spend.k = "new" /\ primary = 0
    /\ pend.k \in {"new", "resume", "fork", "clone", "reload"}
    /\ LET t == nxt
           t2 == nxt + 1
           f == spend.file
           own == IF f \in FileLess THEN NoKey ELSE [f |-> f, t |-> 0]
           asPrimary == ~Has("rolelessKey") \/ own = pend.key
       IN
       /\ st' = [st EXCEPT ![t] = "retired", ![t2] = "live"]
       /\ why' = [why EXCEPT ![t] = "reload"]
       /\ role' = [role EXCEPT ![t] = IF asPrimary THEN "primary" ELSE "secondary",
                                 ![t2] = IF asPrimary THEN "primary" ELSE "secondary"]
       /\ sess' = [sess EXCEPT ![t] = f, ![t2] = f]
       /\ lin' = [lin EXCEPT ![f] = @ \cup {t, t2}]
       /\ nxt' = t + 2
       /\ primary' = IF asPrimary THEN t2 ELSE primary
       /\ last' = IF asPrimary THEN t2 ELSE last
       /\ resets' = IF asPrimary THEN [resets EXCEPT ![t2] = 1] ELSE resets
       /\ predOf' = [predOf EXCEPT ![t] = spend.from, ![t2] = t]
       /\ subBorn' = subBorn \cup {t, t2}
       /\ spend' = NoSpend
    /\ steps' = steps + 1 /\ used' = used \cup {"secRoleless"}
    /\ UNCHANGED <<ep, pend, forking, branch, cell, imp, slot, taken, side,
                   sideAct, wr, entry, intent, reg, svc, fleet, turn, begun,
                   turns, procTurn, evalTurn, wgTok, wgDone, lastTok, prevMax,
                   ownDrop, recorded, dupDone, landed, reads, lzV, adV, notes,
                   userDeclined, fwd, preScope>>

\* #3855 r1: a note is evicted over the cap. With one modelled subagent the
\* cap is never reached by its own notes, so this models the unmodelled
\* subagents' notes pushing it out: any note, at any time, once.
Evict ==
    /\ "Evict" \in Transitions /\ "evict" \notin used
    /\ \E n \in notes : notes' = notes \ {n}
    /\ used' = used \cup {"evict"}
    /\ UNCHANGED <<st, role, sess, ep, why, primary, last, nxt, pend, forking,
                   branch, cell, imp, lin, slot, taken, side, sideAct, wr,
                   entry, intent, reg, svc, fleet, turn, begun, turns,
                   procTurn, evalTurn, wgTok, wgDone, lastTok, prevMax,
                   ownDrop, recorded, resets, dupDone, landed, reads, predOf,
                   lzV, adV, steps, spend, subBorn, userDeclined, fwd, preScope>>

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
    \* Not the coordinator's own (F1): only the turn's own id moves.
    /\ turn' = IF OwnTurn(primary) THEN [turn EXCEPT ![primary] = @ + 1]
               ELSE turn
    /\ begun' = [begun EXCEPT ![primary] = @ + 1]
    /\ turns' = turns + 1
    /\ Draw
    /\ UNCHANGED <<st, role, sess, ep, why, primary, last, nxt, pend, forking,
                   branch, cell, imp, lin, slot, taken, side, sideAct, wr,
                   entry, intent, reg, svc, fleet, wgTok, ownDrop, recorded,
                   resets, dupDone, landed, reads, predOf, lzV, adV, steps,
                   used>>

\* A subagent's turn_start. onTurnStart passes the turn's session id to
\* runtime.beginTurn (#3613), which advances only that session's turn state;
\* before it (TC shared) the call advanced the primary's turn (N2).
SecTurn ==
    /\ "SecTurn" \in Transitions /\ turns < MaxTurns
    /\ \E s \in Tickets :
          /\ st[s] = "live" /\ role[s] = "secondary"
          /\ LET tgt == IF SecPolicy("TC") = "shared" \/ OwnTurn(s)
                        THEN last ELSE s
             IN turn' = [turn EXCEPT ![tgt] = @ + 1]
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

\* Actions that move no #3855 r2 variable keep them in Next.
Next ==
    \/ \E k \in {"fork", "clone"} : BeforeFork(k) /\ UNCHANGED r2V
    \/ CancelFork /\ UNCHANGED r2V
    \/ \E k \in {"new", "resume", "fork", "clone", "reload", "quit"} :
          Retire(k) /\ UNCHANGED r2V
    \/ RetireSub /\ UNCHANGED r2V
    \/ Begin
    \/ BeginDemoted
    \/ BeginDeclined
    \/ \E w \in {"post", "pre", "unstarted"} : InterruptAt(w)
    \/ PiFork
    \/ Tree /\ UNCHANGED r2V
    \/ IdleReset /\ UNCHANGED r2V
    \/ SecStart
    \/ \E k \in {"reload", "fork"} : SecBind(k)
    \/ SecEnd /\ UNCHANGED r2V
    \/ \E k \in {"reload", "fork", "new"} : SecDown(k)
    \/ SecUp
    \/ SecRoleless
    \/ Evict
    \/ Dup /\ UNCHANGED r2V
    \/ TurnStart /\ UNCHANGED r2V
    \/ SecTurn /\ UNCHANGED r2V
    \/ WidgetWrite /\ UNCHANGED r2V
    \/ Activate /\ UNCHANGED r2V
    \/ Context /\ UNCHANGED r2V
    \/ \E x \in FlightIds : WriterBegin(x) /\ UNCHANGED r2V
    \/ \E x \in FlightIds : LandRead(x) /\ UNCHANGED r2V
    \/ LandHeartbeat /\ UNCHANGED r2V
    \/ LandLsp /\ UNCHANGED r2V
    \/ LandAdvisory /\ UNCHANGED r2V
    \/ \E t \in Tickets : RegLand(t) /\ UNCHANGED r2V

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

\* #3607, N2 and #3613: a primary transition never removes a live
\* secondary's own facts, and every live scope's turn state is moved by its
\* own turns only: a secondary's turn never moves the primary's, and the
\* primary's turns and replacements never move or reset a secondary's (its
\* per-turn records are not dropped).
SecondaryIsolation ==
    /\ \A s \in Tickets :
          (st[s] = "live" /\ role[s] = "secondary")
              => {x \in landed : x.o = s} \subseteq cell[CellOf(s)]
    /\ \A t \in Tickets :
          (st[t] = "live" /\ role[t] # "-") => turn[TurnCellOf(t)] = begun[t]

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

\* The subagent's conversations: its own file and its fork's.
SubagentFiles == {"S", "T"}

\* #3604: a live scope of a primary's conversation holds every activation
\* the conversation made (/tree keeps them, D7; /new starts a conversation
\* of its own). A demoted real successor is a secondary on the primary's
\* file, so the check covers every role.
NoLostActivation ==
    \A t \in Tickets :
        (st[t] = "live" /\ sess[t] \notin SubagentFiles) =>
            \A o \in acts : o \in lin[sess[t]] => o \in act[t]

\* #3855's answer to the #3835 r2 question: the same over the subagent's own
\* conversations. A secondary never stashes or adopts, so its own /fork or
\* /reload starts without its activations; the merged design accepts that
\* (AcceptedSecondaryForkActivation). A secondary hand-off would flip it.
SecondaryKeepsActivation ==
    \A t \in Tickets :
        (st[t] = "live" /\ sess[t] \in SubagentFiles) =>
            \A o \in acts : o \in lin[sess[t]] => o \in act[t]

\* #3748: an advisory reaches only a context call of its own conversation.
NoCrossSessionDelivery ==
    \A d \in advOut : d.o \in lin[sess[d.to]]

\* #3881 r2: an advisory reaches only a context call on its producer's
\* session file. Only /reload carries an advisory to a successor (AD's
\* policy), and /reload keeps the file, so a delivery across files crossed a
\* /fork, /clone or resume.
AdvisoryStaysInSession == \A d \in advOut : sess[d.o] = sess[d.to]

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

\* #3855 r2 (review F3): the process has a primary whenever no primary
\* replacement is pending. A declined real successor leaves it with none.
HasPrimary == pend.k = "none" => primary # 0

\* #3855 r2 (review F1, R1): the primary slot is never held by a scope of the
\* subagent's chain. A gap start the primary did not name took it.
PrimaryIsUsers == primary # 0 => primary \notin subBorn

\* #3855 r2 (review F2): a user conversation's own replacement start is never
\* declined while no scope holds the primary slot. Round 1's notes declined
\* it after an R1 demotion, so the subagent kept the primary.
UserNotDeclined == ~userDeclined

=============================================================================
