------------------------- MODULE TreeSitterTrapBudget -------------------------
(***************************************************************************)
(* The web-tree-sitter trap budget and its per-input trap map, in one      *)
(* process (clients/tree-sitter-client.ts). Issues #3605, #3678, #3707;    *)
(* PRs #3673, #3706, #3731. Symbols, not line numbers, are cited.          *)
(*                                                                          *)
(* One wasm instance serves the whole process, so the state is process-    *)
(* lifetime: no session boundary resets it (`wasmTraps`, `trappedInputs`, *)
(* `wasmAborted`). The model has no session action for that reason.        *)
(*                                                                          *)
(* `reportWasmAbort(thrown, input)`:                                        *)
(*  - an input already in `trappedInputs`: its count rises, no budget.     *)
(*  - otherwise an entry {traps: 1, by: input.caller} is added and one     *)
(*    budget unit is spent (`++wasmTraps`); past `WASM_TRAP_BUDGET` (3)    *)
(*    the runtime is poisoned (`wasmAborted`).                              *)
(*  - no input: one budget unit, no entry.                                  *)
(* `clearWasmInput(input)` drops the entry when `by === input.caller`.     *)
(* A charged input (`wasmInputTraps(input) > 1`) is skipped.               *)
(*                                                                          *)
(* Keys: a file's input is (language, content) (`wasmInputKey`); a         *)
(* compiled query's input is `wasmQueryInput(queryKey)`. A content value   *)
(* stands for (language, content): two files with the same content share   *)
(* one entry, as in the code.                                               *)
(*                                                                          *)
(* Atomicity. JavaScript runs one call at a time between awaits:           *)
(*  - `parseFileAndUse`: the charged check, the parse, the parse-phase     *)
(*    clear, `consume` and its clear are one synchronous region after      *)
(*    `getParser`'s await, so `Parse` is one step.                         *)
(*  - `compileQueryBatch`: the batch-key check runs before                 *)
(*    `await loadWebTreeSitter()`; the probe loop and the combined compile *)
(*    after it are synchronous. So `BatchCheck`, then `BatchBuild`.        *)
(*  - `compileRawQuery`: the charged check runs before `await loadLanguage`*)
(*    and `await loadWebTreeSitter()`; the compile after. So `RawCheck`,   *)
(*    then `RawDo`.                                                         *)
(*  - the symbol extractor's `compileQuery` (in `init`) has no charged     *)
(*    check and no clear; each owner memoizes one extractor per language   *)
(*    (review-graph builder, module-report, blocker-freshness), so         *)
(*    `ExtInit(o)` runs once per owner.                                     *)
(*                                                                          *)
(* The environment. A trap site either always traps (`poison`, chosen at   *)
(* Init from `PoisonCandidates`: an input-driven, deterministic trap), or  *)
(* traps as a one-off (`heap`, at most `MaxHeap` in a run: heap damage     *)
(* not attributable to the input). `Flaky` lets a poisoned site also       *)
(* succeed: an input-driven trap that is stateful (#3706 residual R1).     *)
(*                                                                          *)
(* Ghosts: `hits[i]` counts the traps whose culprit is input i;            *)
(* `poisonHit` is the set of inputs that trapped deterministically; `heap` *)
(* counts one-offs. They are the evidence the budget may spend.            *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets, Sequences

CONSTANTS
    Files,            \* file paths
    Contents,         \* content values; a file's input is its content
    Consumers,        \* withParsedTree caller identities: "rg", "mr", "rqA", "rqB"
    Swallowers,       \* consumers that report a trap and return normally
    Owners,           \* the extractor owners, one memoized init each
    Budget,           \* WASM_TRAP_BUDGET
    MaxHeap,          \* one-off traps allowed in a run
    MaxPend,          \* concurrent compiles past their charged check, per key
    PoisonCandidates, \* trap sites that may be poisoned
    Flaky,            \* a poisoned site may also succeed (R1)
    EnableFiles, EnableExt, EnableBatch, EnableRaw,
    \* The merged behaviour is every switch below TRUE.
    Classify,         \* #3673: a trap is classified and contained to its file
    KeyInputs,        \* #3673 r2 (F1): a repeat trap on an input spends no budget
    Decay,            \* #3706 F-A: a clean success by the trapper drops the entry
    KeyExtractor,     \* #3706 F-C: the extractor compile is keyed to its query
    ParseNoCaller,    \* #3706 F5: the parse input carries no caller
    ConsumeSharedKey, \* #3706 F6: the consumer shares the parse input's key
    OwnHealOnly,      \* #3706 F2: only the entry's trapper may decay it (consume phase)
    FullIdentity,     \* #3706 F4: identity is label plus query, not label only
    GuardF1,          \* #3706 F1: no clear when the call itself raised the count
    KeyBatch,         \* #3731: the batch probe and combined compile are keyed
    CacheGuard,       \* #3731: a build that trapped is not cached
    DistinctBatchKeys \* #3731 FL10: each rule set has its own batch key

\* The first file starts on content "c1", every other file on "c2".
InitContent == [f \in Files |-> IF f = "fa" THEN "c1" ELSE "c2"]

\* An identity is a caller label plus, for the two query consumers, the query
\* identity (#3706 F4). "rg" is the review-graph extractor and "mr" the
\* module-report extractor (both rethrow a trap); "rqA" and "rqB" are
\* runQueriesOnFile over rule sets A and B: label "rq", and each carries its
\* batch key (`runQueriesOnFile\0<batch key>`). They swallow a trap.
NoId == "none"
Ids == Consumers \cup {NoId}
LabelOf(id) == IF id \in {"rqA", "rqB"} THEN "rq" ELSE id
SameId(a, b) == IF FullIdentity THEN a = b ELSE LabelOf(a) = LabelOf(b)

\* Two rule sets over two rules; r2 is in both (#3731: a rule edit that
\* rebuilds batches holding one poisoned rule). A consumer <<"rq", n>> is
\* runQueriesOnFile over rule set n (its identity carries the batch key).
SetNames == {"A", "B"}
RulesOf(n) == IF n = "A" THEN {"r1", "r2"} ELSE {"r2"}
OrderOf(n) == IF n = "A" THEN <<"r1", "r2">> ELSE <<"r2">>
Rules == {"r1", "r2"}

\* Culprit inputs and trap-map keys. A key is a triple so that the per-caller
\* mutants (F5, F6) can widen it; the merged key's last field is "none".
Inputs == {<<"src", c>> : c \in Contents} \cup {<<"probe", r>> : r \in Rules}
          \cup {<<"batch", n>> : n \in SetNames} \cup {<<"ext", "q">>}
FKey(c, id) == <<"src", c, id>>
PKey(r) == <<"probe", r, "none">>
BKey(n) == IF DistinctBatchKeys THEN <<"batch", n, "none">>
           ELSE <<"batch", "*", "none">>
EKey == <<"ext", "q", "none">>
AllKeys == {FKey(c, id) : c \in Contents, id \in Ids}
           \cup {PKey(r) : r \in Rules}
           \cup {<<"batch", n, "none">> : n \in SetNames \cup {"*"}}
           \cup {EKey}
\* The inputs a key stands for: every one of them is skipped when it is charged.
InputsOf(k) == IF k[1] = "batch" /\ k[2] = "*"
               THEN {<<"batch", n>> : n \in SetNames}
               ELSE {<<k[1], k[2]>>}

\* Trap sites, named as strings so a config can list the poisoned ones.
ParseSite(c) == "parse:" \o c
ConsumeSite(c, id) == "consume:" \o c \o ":" \o id
ProbeSite(r) == "probe:" \o r
CombSite(n) == "comb:" \o n
ExtSite == "ext"


Empty == [traps |-> 0, by |-> NoId]
NoCache == [st |-> "none", rules |-> {}]
NullCache == [st |-> "null", rules |-> {}]
Min2(x) == IF x > 2 THEN 2 ELSE x

VARIABLES
    content,    \* [Files -> Contents]
    entry,      \* trappedInputs: [AllKeys -> [traps, by]]; traps 0 = absent
    spent,      \* wasmTraps
    heap,       \* ghost: one-off traps so far
    hits,       \* ghost: traps per culprit input (saturates at 2)
    poisonHit,  \* ghost: inputs that trapped deterministically
    stale,      \* ghost: keys whose entry survived its trapper's clean success
    attempted,  \* ghost: keys a checked site ran while they were charged
    lost,       \* ghost: <<file, input>> pairs whose extraction a call lost
    poison,     \* the environment: poisoned sites
    extDone,    \* owners whose extractor init ran
    rawCached,  \* queryCache holds rule r's compiled raw query
    pendRaw,    \* compileRawQuery calls past their charged check, per rule
    cache,      \* queryBatchCache, per rule set
    pendB       \* compileQueryBatch builds past their batch-key check

vars == <<content, entry, spent, heap, hits, poisonHit, stale, attempted, lost,
          poison, extDone, rawCached, pendRaw, cache, pendB>>

Aborted == spent > Budget

(* The mutable trap state as one record, so a synchronous region can be     *)
(* written as a chain of steps.                                             *)
Cur == [e |-> entry, sp |-> spent, hp |-> heap, hi |-> hits,
        ph |-> poisonHit, stl |-> stale, at |-> attempted]
SetSt(s) == /\ entry' = s.e /\ spent' = s.sp /\ heap' = s.hp
            /\ hits' = s.hi /\ poisonHit' = s.ph /\ stale' = s.stl
            /\ attempted' = s.at

Outs == {"ok", "poison", "heap"}
Allowed(site, o, hp) ==
    \/ o = "poison" /\ site \in poison
    \/ o = "ok" /\ (site \notin poison \/ Flaky)
    \/ o = "heap" /\ site \notin poison /\ hp < MaxHeap

(* reportWasmAbort(thrown, input) for a trap of kind o on culprit input i,  *)
(* charged to key k with identity id; `keyed` is FALSE for a site that     *)
(* reports without an input.                                               *)
Rep(s, i, k, id, o, keyed) ==
    LET s1 == [s EXCEPT !.hi[i] = Min2(@ + 1),
                        !.ph = IF o = "poison" THEN @ \cup {i} ELSE @,
                        !.hp = IF o = "heap" THEN @ + 1 ELSE @]
    IN IF ~Classify THEN s1          \* pre-#3673: a trap classifies as nothing
       ELSE IF keyed /\ s1.e[k].traps > 0
            THEN [s1 EXCEPT !.e[k].traps = Min2(@ + 1)]
            ELSE [s1 EXCEPT !.e = IF keyed
                                  THEN [s1.e EXCEPT ![k] = [traps |-> 1, by |-> id]]
                                  ELSE s1.e,
                            !.sp = @ + 1]

(* clearWasmInput after a clean success on key k by identity id.            *)
(* `ownOnly` is FALSE only for a consume-phase clear under mutant F2.       *)
Clr(s, k, id, ownOnly) ==
    IF Decay /\ s.e[k].traps > 0 /\ (~ownOnly \/ SameId(s.e[k].by, id))
    THEN [s EXCEPT !.e[k] = Empty]
    ELSE s

(* The two ghosts are written by each action at its own site, never inside  *)
(* Clr or the skip test, so a site that omits its heal or its skip is still *)
(* seen (review F1 on #3829).                                               *)
(* Mark: after a clean success by id on key k, an entry by id that is still *)
(* there survived its trapper's success.                                    *)
Mark(s, k, id) ==
    IF s.e[k].traps > 0 /\ s.e[k].by = id
    THEN [s EXCEPT !.stl = @ \cup {k}] ELSE s
(* Try: a checked site is about to run on key k.                            *)
Try(s, k) == IF s.e[k].traps > 1 THEN [s EXCEPT !.at = @ \cup {k}] ELSE s

ChargedKey(k) == entry[k].traps > 1

TypeOK ==
    /\ content \in [Files -> Contents]
    /\ entry \in [AllKeys -> [traps : 0..2, by : Ids]]
    /\ spent \in 0..(Budget + 1)
    /\ heap \in 0..MaxHeap
    /\ hits \in [Inputs -> 0..2]
    /\ poisonHit \subseteq Inputs
    /\ stale \subseteq AllKeys
    /\ attempted \subseteq AllKeys
    /\ lost \subseteq (Files \X Inputs)
    /\ poison \subseteq PoisonCandidates
    /\ extDone \subseteq Owners
    /\ rawCached \in [Rules -> BOOLEAN]
    /\ pendRaw \in [Rules -> 0..MaxPend]
    /\ cache \in [SetNames -> [st : {"none", "null", "ok"}, rules : SUBSET Rules]]
    /\ pendB \in [SetNames -> 0..MaxPend]

Init ==
    /\ content = InitContent
    /\ entry = [k \in AllKeys |-> Empty]
    /\ spent = 0
    /\ heap = 0
    /\ hits = [i \in Inputs |-> 0]
    /\ poisonHit = {}
    /\ stale = {}
    /\ attempted = {}
    /\ lost = {}
    /\ poison \in SUBSET PoisonCandidates
    /\ extDone = {}
    /\ rawCached = [r \in Rules |-> FALSE]
    /\ pendRaw = [r \in Rules |-> 0]
    /\ cache = [n \in SetNames |-> NoCache]
    /\ pendB = [n \in SetNames |-> 0]

-----------------------------------------------------------------------------
(* parseFileAndUse(f, ..., consume, caller = id). *)
Parse(f, id) ==
    /\ EnableFiles
    /\ ~Aborted
    /\ LET c == content[f]
           i == <<"src", c>>
           kp == IF ParseNoCaller THEN FKey(c, NoId) ELSE FKey(c, id)
           kc == IF ConsumeSharedKey THEN kp ELSE FKey(c, id)
           s0 == Cur
           sr == Try(s0, kp)                  \* the run branch's own record
       IN \/ /\ s0.e[kp].traps > 1              \* charged: skipped (D1)
             /\ lost' = lost \cup {<<f, i>>}
             /\ UNCHANGED <<entry, spent, heap, hits, poisonHit, stale, attempted>>
          \/ /\ s0.e[kp].traps <= 1
             /\ \E o1 \in Outs, o2 \in Outs :
                  /\ Allowed(ParseSite(c), o1, sr.hp)
                  /\ IF o1 # "ok"
                     THEN \* the parse traps: `reportWasmAbort(err, input)`
                          /\ SetSt(Rep(sr, i, kp, NoId, o1, KeyInputs))
                          /\ lost' = lost \cup {<<f, i>>}
                     ELSE \* a clean parse heals a parse-phase entry (#3706 F-A)
                          LET s1 == Mark(Clr(sr, kp, NoId, TRUE), kp, NoId) IN
                          /\ Allowed(ConsumeSite(c, id), o2, s1.hp)
                          /\ IF o2 = "ok"
                             THEN /\ SetSt(Mark(Clr(s1, kc, id, OwnHealOnly), kc, id))
                                  /\ UNCHANGED lost
                             ELSE LET s2 == Rep(s1, i, kc, id, o2, KeyInputs) IN
                                  IF id \in Swallowers
                                  THEN \* returns normally; #3706 F1: no clear when
                                       \* this call raised the count
                                       /\ SetSt(IF GuardF1 /\ Classify /\ KeyInputs
                                                THEN s2 ELSE Clr(s2, kc, id, OwnHealOnly))
                                       /\ UNCHANGED lost
                                  ELSE /\ SetSt(s2)
                                       \* pre-#3673: the trap rethrows and rejects the
                                       \* whole build (every file's extraction)
                                       /\ lost' = lost \cup
                                            (IF Classify THEN {<<f, i>>}
                                             ELSE {<<g, <<"src", content[g]>>>> : g \in Files})
    /\ UNCHANGED <<content, poison, extDone, rawCached, pendRaw, cache, pendB>>

(* An edit gives a file a new input (#3605 K5: a charge never outlives a     *)
(* content change).                                                         *)
Edit(f) ==
    /\ EnableFiles
    /\ \E c \in Contents \ {content[f]} : content' = [content EXCEPT ![f] = c]
    /\ UNCHANGED <<entry, spent, heap, hits, poisonHit, stale, attempted, lost,
                   poison, extDone, rawCached, pendRaw, cache, pendB>>

(* TreeSitterSymbolExtractor.init -> compileQuery, once per owner. *)
ExtInit(o) ==
    /\ EnableExt
    /\ ~Aborted
    /\ o \notin extDone
    /\ extDone' = extDone \cup {o}
    /\ \E oc \in Outs :
         /\ Allowed(ExtSite, oc, heap)
         /\ IF oc = "ok"
            THEN UNCHANGED <<entry, spent, heap, hits, poisonHit, stale, attempted>>
            ELSE SetSt(Rep(Cur, <<"ext", "q">>, EKey, NoId, oc,
                           KeyInputs /\ KeyExtractor))
    /\ UNCHANGED <<content, lost, poison, rawCached, pendRaw, cache, pendB>>

(* compileRawQuery: queryCache miss, then the charged check, then awaits. *)
RawCheck(r) ==
    /\ EnableRaw
    /\ ~Aborted
    /\ ~rawCached[r]
    /\ ~ChargedKey(PKey(r))
    /\ pendRaw[r] < MaxPend
    /\ pendRaw' = [pendRaw EXCEPT ![r] = @ + 1]
    /\ attempted' = Try(Cur, PKey(r)).at
    /\ UNCHANGED <<content, entry, spent, heap, hits, poisonHit, stale, lost,
                   poison, extDone, rawCached, cache, pendB>>

RawDo(r) ==
    /\ pendRaw[r] > 0
    /\ pendRaw' = [pendRaw EXCEPT ![r] = @ - 1]
    /\ IF Aborted
       THEN UNCHANGED <<entry, spent, heap, hits, poisonHit, stale, attempted, rawCached>>
       ELSE \E oc \in Outs :
              /\ Allowed(ProbeSite(r), oc, heap)
              /\ IF oc = "ok"
                 THEN /\ SetSt(Mark(Clr(Cur, PKey(r), NoId, TRUE), PKey(r), NoId))
                      /\ rawCached' = [rawCached EXCEPT ![r] = TRUE]
                 ELSE /\ SetSt(Rep(Cur, <<"probe", r>>, PKey(r), NoId, oc, KeyInputs))
                      /\ UNCHANGED rawCached
    /\ UNCHANGED <<content, lost, poison, extDone, cache, pendB>>

RawEvict(r) ==
    /\ rawCached[r]
    /\ rawCached' = [rawCached EXCEPT ![r] = FALSE]
    /\ UNCHANGED <<content, entry, spent, heap, hits, poisonHit, stale, attempted,
                   lost, poison, extDone, pendRaw, cache, pendB>>

(* compileQueryBatch: cache miss and the batch-key check (a charged batch   *)
(* key builds a null without trapping, and that null is cached).            *)
BatchCheck(n) ==
    /\ EnableBatch
    /\ ~Aborted
    /\ cache[n].st = "none"
    /\ pendB[n] < MaxPend
    /\ IF KeyBatch /\ ChargedKey(BKey(n))
       THEN /\ cache' = [cache EXCEPT ![n] = NullCache]
            /\ UNCHANGED <<pendB, attempted>>
       ELSE /\ pendB' = [pendB EXCEPT ![n] = @ + 1]
            /\ attempted' = Try(Cur, BKey(n)).at
            /\ UNCHANGED cache
    /\ UNCHANGED <<content, entry, spent, heap, hits, poisonHit, stale, lost,
                   poison, extDone, rawCached, pendRaw>>

(* The probe loop: one step per rule of the sequence, all in one action.    *)
(* acc = [s, inc (rules kept), trapped, dead (runtime poisoned), ok].       *)
RECURSIVE Probe(_, _, _)
Probe(seq, oc, acc) ==
    IF seq = <<>> \/ acc.dead \/ ~acc.ok THEN acc
    ELSE LET r == Head(seq)
             s == Try(acc.s, PKey(r))        \* the compile branch's own record
         IN IF KeyBatch /\ acc.s.e[PKey(r)].traps > 1
            THEN Probe(Tail(seq), oc, acc)                 \* charged: skipped
            ELSE IF ~Allowed(ProbeSite(r), oc[r], s.hp)
            THEN [acc EXCEPT !.ok = FALSE]
            ELSE IF oc[r] = "ok"
            THEN Probe(Tail(seq), oc,
                       [acc EXCEPT !.s = Mark(IF KeyBatch THEN Clr(s, PKey(r), NoId, TRUE) ELSE s,
                                              PKey(r), NoId),
                                   !.inc = @ \cup {r}])
            ELSE LET s2 == Rep(s, <<"probe", r>>, PKey(r), NoId, oc[r],
                               KeyBatch /\ KeyInputs)
                 IN IF s2.sp > Budget
                    THEN [acc EXCEPT !.s = s2, !.dead = TRUE]  \* returns null untrapped
                    ELSE Probe(Tail(seq), oc,
                               [acc EXCEPT !.s = s2, !.trapped = TRUE])

(* The combined compile after the probe loop. *)
Combine(n, occ, acc) ==
    IF acc.dead \/ ~acc.ok THEN [acc EXCEPT !.val = NullCache]
    ELSE IF acc.inc = {} THEN [acc EXCEPT !.val = NullCache]
    ELSE IF ~Allowed(CombSite(n), occ, acc.s.hp) THEN [acc EXCEPT !.ok = FALSE]
    ELSE IF occ = "ok"
    THEN [acc EXCEPT !.s = Mark(IF KeyBatch THEN Clr(acc.s, BKey(n), NoId, TRUE) ELSE acc.s,
                                BKey(n), NoId),
                     !.val = [st |-> "ok", rules |-> acc.inc]]
    ELSE LET s2 == Rep(acc.s, <<"batch", n>>, BKey(n), NoId, occ, KeyBatch /\ KeyInputs)
         IN IF s2.sp > Budget
            THEN [acc EXCEPT !.s = s2, !.dead = TRUE, !.val = NullCache]
            ELSE [acc EXCEPT !.s = s2, !.trapped = TRUE, !.val = NullCache]

BatchBuild(n) ==
    /\ pendB[n] > 0
    /\ pendB' = [pendB EXCEPT ![n] = @ - 1]
    /\ IF Aborted
       THEN \* a compile on a poisoned runtime returns null; B13 caches it
            /\ cache' = [cache EXCEPT ![n] = NullCache]
            /\ UNCHANGED <<entry, spent, heap, hits, poisonHit, stale, attempted>>
       ELSE \E oc \in [Rules -> Outs], occ \in Outs :
              LET acc0 == [s |-> Cur, inc |-> {}, trapped |-> FALSE,
                           dead |-> FALSE, ok |-> TRUE, val |-> NullCache]
                  res == Combine(n, occ, Probe(OrderOf(n), oc, acc0))
              IN /\ res.ok
                 /\ SetSt(res.s)
                 /\ cache' = IF CacheGuard /\ res.trapped
                             THEN cache
                             ELSE [cache EXCEPT ![n] = res.val]
    /\ UNCHANGED <<content, lost, poison, extDone, rawCached, pendRaw>>

(* LRU eviction, or a rule edit that reloads the rule set. *)
BatchEvict(n) ==
    /\ cache[n].st # "none"
    /\ cache' = [cache EXCEPT ![n] = NoCache]
    /\ UNCHANGED <<content, entry, spent, heap, hits, poisonHit, stale, attempted,
                   lost, poison, extDone, rawCached, pendRaw, pendB>>

Next ==
    \/ \E f \in Files, id \in Consumers : Parse(f, id)
    \/ \E f \in Files : Edit(f)
    \/ \E o \in Owners : ExtInit(o)
    \/ \E r \in Rules : RawCheck(r) \/ RawDo(r) \/ RawEvict(r)
    \/ \E n \in SetNames : BatchCheck(n) \/ BatchBuild(n) \/ BatchEvict(n)

Spec == Init /\ [][Next]_vars

-----------------------------------------------------------------------------
(* Invariants *)

\* Containment (#3605, #3673): a call loses a file's extraction only through
\* that file's own input (its own trap, or its input charged), or once the
\* runtime is poisoned. A trap in file A never costs an unrelated file B.
Contained == \A p \in lost : hits[p[2]] >= 1 \/ Aborted

\* The budget spends only on evidence (#3605's budget; #3706 and #3731 in the
\* abort direction): each input that traps deterministically costs at most
\* one unit, and each one-off at most one. So the runtime is never poisoned
\* before Budget + 1 distinct pieces of evidence, and no decay lets one input
\* spend twice. #3706's residual R1 (a stateful input-driven trap) is the
\* one documented exception (config ResidualR1).
BudgetOnEvidence == spent <= Cardinality(poisonHit) + heap

\* Counts never leak across keys (#3731 FL10): a charged key skips each input
\* it stands for, so each of them trapped at least twice itself.
NoKeyLeak == \A k \in AllKeys :
                entry[k].traps > 1 => \A i \in InputsOf(k) : hits[i] >= 2

\* #3706 F-A: an entry does not survive a clean success by the identity that
\* trapped (a one-off trap decays instead of charging the input later). The
\* extractor's compile key is exempt: it has no clear and no charged skip.
DecayOnOwnSuccess == stale = {}

\* #3605 K4: a site that checks the charge never runs a charged key: the
\* parse, the batch probe, the batch key and compileRawQuery. The extractor
\* compile has no check. A compile past a check that passed (RawDo, the
\* combined compile in BatchBuild) is the race window, not a skip miss.
NoRunWhenCharged == attempted = {}

\* #3731: a cached batch is degraded only by a permanent cause: each rule it
\* lacks has a charged probe key, and a cached null has a charged batch key
\* (or no rule left), or the runtime is poisoned.
NoCachedTransient ==
    \A n \in SetNames :
        \/ cache[n].st = "none"
        \/ Aborted
        \/ /\ cache[n].st = "ok"
           /\ \A r \in RulesOf(n) \ cache[n].rules : ChargedKey(PKey(r))
        \/ /\ cache[n].st = "null"
           /\ \/ ChargedKey(BKey(n))
              \/ \A r \in RulesOf(n) : ChargedKey(PKey(r))

\* Non-vacuity only (the Reach* configs expect these violated): the pass
\* configs reach a poisoned runtime, a charged input, and a cached batch that
\* skips a charged rule.
NeverAborted == ~Aborted
NeverCharged == \A k \in AllKeys : entry[k].traps < 2
NeverSkipCached == \A n \in SetNames :
                      ~(cache[n].st = "ok" /\ cache[n].rules # RulesOf(n))
=============================================================================
