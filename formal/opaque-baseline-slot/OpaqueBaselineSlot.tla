------------------------ MODULE OpaqueBaselineSlot ------------------------
(***************************************************************************)
(* The pending opaque baseline of bash calls and the dispatch dedupe its   *)
(* recoveries feed (#4137). Store: clients/opaque-mutation-scan.ts         *)
(* OpaqueBaselineStore, recorded at tool_call in                           *)
(* clients/runtime-tool-call.ts and taken at tool_result in                *)
(* clients/runtime-tool-result.ts. Dedupe: claimPipelineDispatch and       *)
(* dispatchPipelineAnalysis in clients/runtime-tool-result.ts.             *)
(*                                                                         *)
(* A call (writer) records a baseline, runs its command, takes a baseline  *)
(* at its tool_result and dispatches. Its recovery window holds every path *)
(* written since the baseline's owner recorded (git status filtered by     *)
(* mtime). The paths the command's text names are recognized: one that    *)
(* changed in the window is dispatched with authorship (autonomous         *)
(* writers, the blocker channel). The rest of the window is opaque and is  *)
(* dispatched without authorship (#3226).                                  *)
(*                                                                         *)
(* Actions:                                                                *)
(*  - Record(w): tool_call stores w's baseline under its key. With Retire, *)
(*    entries of a dead turn are retired first, counted. A baseline under *)
(*    the same key is overwritten, and on a full store the oldest is       *)
(*    dropped; either loss is counted;                                     *)
(*  - Write(w): the command runs and writes Writes[w] (possibly nothing);  *)
(*  - Abandon(w): a Blocked call never runs and never gets a tool_result   *)
(*    (a tool_call handler blocked it, or Escape aborted it before it      *)
(*    started; pi then skips afterToolCall);                               *)
(*  - Take(w): tool_result removes the baseline under w's key and plans    *)
(*    the dispatches. Without a baseline, the recognized paths dispatch    *)
(*    without authorship (partial-recognition-no-baseline);                *)
(*  - Dispatch(w): each planned path is claimed at its current content.    *)
(*    The claim is skipped when this turn already analysed that content    *)
(*    and the analysis satisfies the claim (Dedupe);                       *)
(*  - NextTurn: the turn ends once no call is in flight.                   *)
(*                                                                         *)
(* Knobs: Keying "cwd" is the pre-fix store (one key per cwd:generation),  *)
(* "call" one key per tool-call id. Dedupe "content" is the pre-fix        *)
(* dedupe (any analysis of the bytes satisfies any claim), "authority"     *)
(* the fix (an unauthored analysis satisfies only an unauthored claim).    *)
(* Subtract is round 1's sibling subtraction: a recovery leaves out the    *)
(* names of every still-pending entry and of every call that took after    *)
(* this one recorded.                                                      *)
(*                                                                         *)
(* The inline-blocker record of a path (rec) is set by the latest dispatch *)
(* that ran: authored records it, unauthored clears it (a non-autonomous   *)
(* result carries no inline summary). With ClearRule "bytes" (round 3), an *)
(* unauthored dispatch of the very version the authored record is about    *)
(* leaves it (clearInlineBlockers refuses: #3226 says that result is no    *)
(* evidence). "always" is the pre-round-3 clear.                          *)
(*                                                                         *)
(* The dedupe reads the latch, not the history: index.ts clears the latch  *)
(* at every session's turn start, a concurrent secondary's included        *)
(* (#3613). LatchClear admits that clear at any time (SecondaryTurnStart). *)
(***************************************************************************)
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS
    Keying,      \* "cwd" (pre-fix) | "call" (per tool-call id)
    Cap,         \* baselines the store holds before dropping the oldest
    Subtract,    \* TRUE: round 1's sibling subtraction
    Dedupe,      \* "content" (pre-fix) | "authority" (the fix)
    Retire,      \* TRUE: a record retires the entries of a dead turn
    Observe,     \* "counted" (the ledger) | "none" (pre-fix evictionCount)
    Sequential,  \* TRUE: a call records only when no other is in flight
    Scenario,    \* "s8" | "namedSibling" | "failedSibling" | "blockedNamer"
    LatchClear,  \* TRUE: a concurrent session's turn start may clear the latch
    ClearRule    \* "always" (pre-round-3) | "bytes" (round 3's refusal)

Writers == {1, 2, 3}
Paths == {1, 2, 3}
Turns == {0, 1}

(* The calls of each scenario: the paths each names, the paths it writes, *)
(* the calls that fail (isError) and the calls that never get a result.   *)
Name ==
    CASE Scenario = "s8" -> [w \in Writers |-> {w}]
      [] Scenario = "namedSibling" -> <<{1}, {2}, {}>>
      [] Scenario = "failedSibling" -> <<{1}, {2}, {}>>
      [] Scenario = "blockedNamer" -> <<{1}, {}, {}>>
Writes ==
    CASE Scenario = "s8" -> [w \in Writers |-> {w}]
      \* 3 is opaque: it writes 1's path (before or after 1's dispatch) and
      \* the path 2 names but never writes
      [] Scenario = "namedSibling" -> <<{1}, {}, {1, 2}>>
      [] Scenario = "failedSibling" -> <<{1}, {}, {2}>>
      \* 1 is blocked; 2 and 3 are opaque writers of the path 1 names
      [] Scenario = "blockedNamer" -> <<{}, {1}, {1}>>
Fails == IF Scenario = "failedSibling" THEN {2} ELSE {}
Blocked == IF Scenario = "blockedNamer" THEN {1} ELSE {}

VARIABLES
    pc,        \* [Writers -> "new" | "called" | "taken" | "done" | "gone"]
    turn,      \* the current turn
    ver,       \* [Paths -> content version]; a write bumps it
    ran,       \* calls whose command has run
    window,    \* [Writers -> paths written since w recorded]
    slot,      \* sequence of [key, owner, turn], oldest first
    lost,      \* owners whose baseline was overwritten or evicted
    retired,   \* owners whose entry was retired with its dead turn
    ledger,    \* the degradation ledger's opaque-baseline-lost count
    missed,    \* calls that took no baseline
    seen,      \* [Writers -> calls that took after w recorded] (Subtract)
    plan,      \* [Writers -> [rec, auth, opq]] planned at the take
    analysed,  \* <<path, version, authored, turn>> of every dispatch that ran
    latch,     \* the dedupe's view of analysed (lastAnalyzedStateByFile)
    rec,       \* [Paths -> "none" | "authored" | "cleared"]
    recVer     \* [Paths -> the version rec's authored verdict is about]

vars == <<pc, turn, ver, ran, window, slot, lost, retired, ledger, missed,
          seen, plan, analysed, latch, rec, recVer>>

NoPlan == [rec |-> {}, auth |-> {}, opq |-> {}]

TypeOK ==
    /\ pc \in [Writers -> {"new", "called", "taken", "done", "gone"}]
    /\ turn \in Turns
    /\ ver \in [Paths -> 0..3]
    /\ ran \subseteq Writers
    /\ window \in [Writers -> SUBSET Paths]
    /\ lost \subseteq Writers
    /\ retired \subseteq Writers
    /\ ledger \in Nat
    /\ missed \subseteq Writers
    /\ seen \in [Writers -> SUBSET Writers]
    /\ plan \in [Writers -> [rec : SUBSET Paths, auth : SUBSET Paths,
                             opq : SUBSET Paths]]
    /\ analysed \subseteq (Paths \X (0..3) \X BOOLEAN \X Turns)
    /\ latch \subseteq analysed
    /\ rec \in [Paths -> {"none", "authored", "cleared"}]
    /\ recVer \in [Paths -> 0..3]
    /\ Len(slot) <= Cap

Key(w) == IF Keying = "cwd" THEN 0 ELSE w

HasKey(s, k) == \E i \in 1..Len(s) : s[i].key = k
IndexOf(s, k) == CHOOSE i \in 1..Len(s) : s[i].key = k

DeleteAt(s, i) ==
    [j \in 1..(Len(s) - 1) |-> IF j < i THEN s[j] ELSE s[j + 1]]

Owners(s) == {s[i].owner : i \in 1..Len(s)}

Counted(n) == IF Observe = "counted" THEN n ELSE 0

Init ==
    /\ pc = [w \in Writers |-> "new"]
    /\ turn = 0
    /\ ver = [p \in Paths |-> 0]
    /\ ran = {}
    /\ window = [w \in Writers |-> {}]
    /\ slot = <<>>
    /\ lost = {}
    /\ retired = {}
    /\ ledger = 0
    /\ missed = {}
    /\ seen = [w \in Writers |-> {}]
    /\ plan = [w \in Writers |-> NoPlan]
    /\ analysed = {}
    /\ latch = {}
    /\ rec = [p \in Paths |-> "none"]
    /\ recVer = [p \in Paths |-> 0]

InFlight(o) == pc[o] \in {"called", "taken"}

CanRecord(w) ==
    /\ pc[w] = "new"
    /\ (Sequential => \A o \in Writers : ~InFlight(o))

\* tool_call. With Retire, the entries of a dead turn go first (counted).
\* Then the new entry overwrites one under the same key, or is appended,
\* dropping the oldest on a full store; a displaced baseline is counted.
Record(w) ==
    /\ CanRecord(w)
    /\ LET live == IF Retire THEN SelectSeq(slot, LAMBDA e : e.turn = turn)
                   ELSE slot
           gone == Owners(slot) \ Owners(live)
           entry == [key |-> Key(w), owner |-> w, turn |-> turn]
       IN /\ \/ /\ HasKey(live, Key(w))
                /\ LET i == IndexOf(live, Key(w))
                   IN /\ slot' = Append(DeleteAt(live, i), entry)
                      /\ lost' = lost \cup {live[i].owner}
                      /\ ledger' = ledger + Counted(Cardinality(gone) + 1)
             \/ /\ ~HasKey(live, Key(w))
                /\ Len(live) < Cap
                /\ slot' = Append(live, entry)
                /\ lost' = lost
                /\ ledger' = ledger + Counted(Cardinality(gone))
             \/ /\ ~HasKey(live, Key(w))
                /\ Len(live) = Cap
                /\ slot' = Append(Tail(live), entry)
                /\ lost' = lost \cup {Head(live).owner}
                /\ ledger' = ledger + Counted(Cardinality(gone) + 1)
          /\ retired' = retired \cup gone
    /\ pc' = [pc EXCEPT ![w] = "called"]
    /\ UNCHANGED <<turn, ver, ran, window, missed, seen, plan, analysed,
                   latch, rec, recVer>>

\* The command runs and writes its paths; every pending owner's window
\* (the owner of an entry in the store is called or gone) sees them.
Write(w) ==
    /\ pc[w] = "called"
    /\ w \notin ran
    /\ w \notin Blocked
    /\ ran' = ran \cup {w}
    /\ ver' = [p \in Paths |-> IF p \in Writes[w] THEN ver[p] + 1 ELSE ver[p]]
    /\ window' = [o \in Writers |->
                    IF pc[o] \in {"called", "gone"} THEN window[o] \cup Writes[w]
                    ELSE window[o]]
    /\ UNCHANGED <<pc, turn, slot, lost, retired, ledger, missed, seen, plan,
                   analysed, latch, rec, recVer>>

\* A blocked or pre-start-aborted call: no tool_result ever arrives.
Abandon(w) ==
    /\ pc[w] = "called"
    /\ w \in Blocked
    /\ pc' = [pc EXCEPT ![w] = "gone"]
    /\ UNCHANGED <<turn, ver, ran, window, slot, lost, retired, ledger, missed,
                   seen, plan, analysed, latch, rec, recVer>>

\* tool_result: take the baseline under w's key and plan the dispatches.
Take(w) ==
    /\ pc[w] = "called"
    /\ w \in ran
    /\ pc' = [pc EXCEPT ![w] = "taken"]
    /\ LET recW == IF w \in Fails THEN {} ELSE Name[w]
       IN IF HasKey(slot, Key(w))
          THEN LET i == IndexOf(slot, Key(w))
                   rest == DeleteAt(slot, i)
                   changed == window[slot[i].owner]
                   auth == recW \cap changed
                   siblingNames ==
                       UNION {Name[o] : o \in seen[w] \cup Owners(rest)}
                   opq == (changed \ recW)
                              \ (IF Subtract THEN siblingNames ELSE {})
               IN /\ slot' = rest
                  /\ plan' = [plan EXCEPT ![w] =
                                 [rec |-> IF auth = {} THEN {} ELSE recW,
                                  auth |-> auth, opq |-> opq]]
                  /\ seen' = IF Subtract /\ Name[w] # {}
                             THEN [o \in Writers |->
                                     IF o # w /\ pc[o] # "new"
                                     THEN seen[o] \cup {w} ELSE seen[o]]
                             ELSE seen
                  /\ UNCHANGED missed
          ELSE /\ missed' = missed \cup {w}
               /\ plan' = [plan EXCEPT ![w] =
                              [rec |-> recW, auth |-> {}, opq |-> {}]]
               /\ UNCHANGED <<slot, seen>>
    /\ UNCHANGED <<turn, ver, ran, window, lost, retired, ledger, analysed,
                   latch, rec, recVer>>

Authored(w, p) == p \in plan[w].auth
Claimed(w) == plan[w].rec \cup plan[w].opq

\* claimPipelineDispatch: skip a claim whose bytes this turn already analysed,
\* when that analysis satisfies it. It reads the latch, which a concurrent
\* session's turn start may have cleared.
Proceeds(p, a) ==
    ~\E b \in BOOLEAN :
        /\ <<p, ver[p], b, turn>> \in latch
        /\ (Dedupe = "content" \/ b \/ ~a)

\* clearInlineBlockers: an unauthored clean result retires the record unless
\* it is the authored verdict about these very bytes (ClearRule "bytes").
Keeps(p) ==
    /\ ClearRule = "bytes"
    /\ rec[p] = "authored"
    /\ recVer[p] = ver[p]

\* The synthetic writes of one call, each at the path's current bytes.
Dispatch(w) ==
    /\ pc[w] = "taken"
    /\ LET run == {p \in Claimed(w) : Proceeds(p, Authored(w, p))}
           new == {<<p, ver[p], Authored(w, p), turn>> : p \in run}
       IN /\ analysed' = analysed \cup new
          /\ latch' = latch \cup new
          /\ rec' = [p \in Paths |->
                       IF p \in run
                       THEN IF Authored(w, p) THEN "authored"
                            ELSE IF Keeps(p) THEN rec[p] ELSE "cleared"
                       ELSE rec[p]]
          /\ recVer' = [p \in Paths |->
                          IF p \in run /\ Authored(w, p) THEN ver[p]
                          ELSE recVer[p]]
    /\ pc' = [pc EXCEPT ![w] = "done"]
    /\ UNCHANGED <<turn, ver, ran, window, slot, lost, retired, ledger, missed,
                   seen, plan>>

\* index.ts turn_start for a concurrent session: `runtime.beginTurn(sub)` and
\* `clearLastAnalyzedStateCache()`. The primary's turn, tokens and records are
\* untouched (#3613); only the dedupe's latch goes.
SecondaryTurnStart ==
    /\ LatchClear
    /\ latch # {}
    /\ latch' = {}
    /\ UNCHANGED <<pc, turn, ver, ran, window, slot, lost, retired, ledger,
                   missed, seen, plan, analysed, rec, recVer>>

NextTurn ==
    /\ turn = 0
    /\ \A o \in Writers : ~InFlight(o)
    /\ \E o \in Writers : pc[o] # "new"
    /\ turn' = 1
    /\ UNCHANGED <<pc, ver, ran, window, slot, lost, retired, ledger, missed,
                   seen, plan, analysed, latch, rec, recVer>>

Next ==
    \/ NextTurn
    \/ SecondaryTurnStart
    \/ \E w \in Writers :
          Record(w) \/ Write(w) \/ Abandon(w) \/ Take(w) \/ Dispatch(w)

Spec == Init /\ [][Next]_vars

-----------------------------------------------------------------------------
(* A finished call that wrote a path it names got an authored analysis of it. *)
EveryWriteAttributed ==
    \A w \in Writers :
        (pc[w] = "done" /\ w \notin Fails) =>
            \A p \in Name[w] \cap Writes[w] :
                \E v \in 0..3, t \in Turns : <<p, v, TRUE, t>> \in analysed

(* For a path no other call writes, the call's blocker record survives. *)
BlockerKept ==
    \A w \in Writers :
        (pc[w] = "done" /\ w \notin Fails) =>
            \A p \in Name[w] \cap Writes[w] :
                (\A o \in Writers \ {w} : p \notin Writes[o])
                    => rec[p] = "authored"

(* The clear rule's other half: an authored record about older bytes does  *)
(* not outlive an unauthored analysis of the path's current bytes. The     *)
(* refusal is for the very bytes the verdict is about, nothing wider.      *)
StaleRecordCleared ==
    \A p \in Paths :
        (rec[p] = "authored" /\ recVer[p] # ver[p]) =>
            ~\E t \in Turns : <<p, ver[p], FALSE, t>> \in analysed

(* Shape 54, the no-drop side: once no call is in flight, the latest bytes  *)
(* of every written path were analysed, unless a counted loss took the      *)
(* writer's baseline.                                                       *)
NoDrop ==
    (\A o \in Writers : ~InFlight(o)) =>
        \A p \in Paths :
            ver[p] > 0 =>
                \/ \E a \in BOOLEAN, t \in Turns :
                       <<p, ver[p], a, t>> \in analysed
                \/ \E o \in missed \cup lost : p \in Writes[o]

(* Every displaced or retired baseline is counted once, and a miss is never *)
(* unrecorded.                                                             *)
SlotLossObservable ==
    /\ ledger = Cardinality(lost) + Cardinality(retired)
    /\ missed # {} => ledger > 0

(* The bytes bound: once the current turn has recorded, no entry of an      *)
(* earlier turn is left (on a non-git project each holds a tree snapshot).  *)
StaleRetired ==
    (\E i \in 1..Len(slot) : slot[i].turn = turn) =>
        \A i \in 1..Len(slot) : slot[i].turn = turn

(* Retirement never takes a call that can still get its result. *)
RetiresOnlyAbandoned == \A w \in retired : pc[w] = "gone"
=============================================================================
