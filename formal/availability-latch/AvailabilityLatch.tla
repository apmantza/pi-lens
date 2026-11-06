------------------------ MODULE AvailabilityLatch ------------------------
(***************************************************************************)
(* The runner availability latch and the probe flights that write it       *)
(* (#5333). Latch: createAvailabilityLatch in                              *)
(* clients/dispatch/runners/utils/availability-policy.ts. Flights: the     *)
(* sg sweep (isSgAvailableAsync), createCwdCachedProbe and                 *)
(* createAvailabilityChecker in clients/dispatch/runners/utils/            *)
(* runner-helpers.ts. The README has the action-to-code map.               *)
(*                                                                         *)
(* One latch, one flight slot, a bounded number of probes. Three counters  *)
(* meet in it:                                                             *)
(*  - avGen, the dispatch availability generation               *)
(*    (resetDispatchAvailabilityState bumps it at session_start);          *)
(*  - instGen, the install-retry generation                                *)
(*    (resetInstallRetryLatches, the next line of the same reset block);    *)
(*  - trustGen, the project trust generation (a trust adoption bumps it).  *)
(*                                                                         *)
(* A probe captures avGen, trustGen, instGen and the latch it will write   *)
(* when it starts (pGen, pTrust, pInst, pLatch). Its verdict lands when    *)
(* the probe settles, after an await. Every verdict the latch holds        *)
(* carries the capture of the probe that wrote it (vGen, vTrust, vInst).   *)
(*                                                                         *)
(* Actions:                                                                *)
(*  - SessionStart: the counters avGen and instGen bump together. Nothing  *)
(*    else changes: each owner clears its own state lazily, at its next    *)
(*    touch (ensureCurrentGeneration, ensureCurrentSgGeneration);          *)
(*  - TrustAdopt: trustGen bumps (setProjectTrustState at session_start    *)
(*    or turn_start);                                                      *)
(*  - ExpireCooldown: the transient and install cooldowns elapse;          *)
(*  - Call: a caller touches the owner (ensure), reads the latch, and on a *)
(*    miss either starts a probe or joins the one in flight;               *)
(*  - Settle(p, r): probe p settles with result r and writes the latch.    *)
(*    The flight slot is released under an identity check.                 *)
(*                                                                         *)
(* Knobs:                                                                  *)
(*  - NewLatchPerGen: TRUE is createCwdCachedProbe: ensure replaces the    *)
(*    latch, so a probe from an older generation holds a retired object.   *)
(*    The checker replaces its cache, not a latch (README Scope). FALSE is *)
(*    the sg sweep and a client's own latch: one object reset in place, so *)
(*    every probe writes the live one;                                     *)
(*  - Clear: "touch" is the ensure above. "none" is a process-lived        *)
(*    client latch (govulncheck, security scan): only the trust settle and *)
(*    the install-generation sync ever reset it;                           *)
(*  - SettleGuard: "none" is the code as built (no flight re-checks a      *)
(*    generation after its await), "gen" drops a settle whose capture is   *)
(*    not the current avGen (the candidate fix);                           *)
(*  - TrustStamp: "owed" is #4776 (a note stamps the trust of the first    *)
(*    read that owed a probe). "lastRead" takes the stamp from the latest  *)
(*    such read, which a caller joining the probe in flight overwrites;    *)
(*    "current" stamps the trust at the note, the code before #4776;       *)
(*  - ReadChecksTrust: TRUE is #4530 (a read and a note drop a verdict of  *)
(*    another trust generation), FALSE is the code before it;              *)
(*  - Results: the verdicts a probe may settle with.                       *)
(***************************************************************************)
EXTENDS Integers

CONSTANTS
    NewLatchPerGen,   \* TRUE: a retired latch object per generation
    Clear,            \* "touch" | "none"
    SettleGuard,      \* "none" | "gen"
    TrustStamp,       \* "owed" | "lastRead" | "current"
    ReadChecksTrust,  \* TRUE: #4530
    Results,          \* SUBSET {"ok", "prov", "trans", "inst", "dur"}
    MaxGen,           \* session starts
    MaxTrust,         \* trust adoptions
    MaxProbes,        \* probes started
    Ladder            \* INSTALL_TRANSIENT_COOLDOWNS_MS.length

VARIABLES
    avGen, trustGen, instGen,   \* the three process-wide counters
    latchGen,    \* the avGen the owner last cleared for (Clear = "touch")
    curLatch,    \* identity of the live latch object
    flight,      \* the probe in the flight slot, 0 when empty
    lat,         \* the live latch's fields
    started,     \* probes started so far
    pc,          \* [1..MaxProbes -> "idle" | "run" | "done"]
    pGen, pTrust, pInst, pLatch,   \* what each probe captured at its start
    served       \* the last verdict a read answered with (ok = FALSE: none yet)

vars == <<avGen, trustGen, instGen, latchGen, curLatch, flight, lat, started,
          pc, pGen, pTrust, pInst, pLatch, served>>

Probes == 1..MaxProbes

\* owedTrustGeneration is null.
NoOwed == -1
\* Nothing has been served yet.
NoServed == [ok |-> FALSE, vTrust |-> 0, trust |-> 0, vGen |-> 0, gen |-> 0]

(* The latch's closure variables. v is the verdict: "none" (available is   *)
(* null), "avail", "prov" (a provisional win), "trans" (a transient false),*)
(* "dur" (a durable false), "exh" (install retries spent). cool is         *)
(* retryAtMs in the future, icool installRetryAtMs, att installAttempts.   *)
(* lTrust is verdictTrustGeneration, lInst installGeneration, owed         *)
(* owedTrustGeneration. vGen, vTrust and vInst are the writer's capture;   *)
(* the code has no such fields, they are the model's provenance.           *)
FreshLatch ==
    [v |-> "none", cool |-> FALSE, icool |-> FALSE, att |-> 0,
     lTrust |-> trustGen, lInst |-> instGen, owed |-> NoOwed,
     vGen |-> 0, vTrust |-> 0, vInst |-> 0]

TypeOK ==
    /\ avGen \in 0..MaxGen /\ instGen \in 0..MaxGen
    /\ trustGen \in 0..MaxTrust
    /\ latchGen \in 0..MaxGen
    /\ flight \in 0..MaxProbes
    /\ lat.v \in {"none", "avail", "prov", "trans", "dur", "exh"}
    /\ lat.att \in 0..(Ladder + 1)
    /\ started \in 0..MaxProbes
    /\ pc \in [Probes -> {"idle", "run", "done"}]

Init ==
    /\ avGen = 0 /\ trustGen = 0 /\ instGen = 0
    /\ latchGen = 0 /\ curLatch = 0 /\ flight = 0
    /\ lat = FreshLatch
    /\ started = 0
    /\ pc = [p \in Probes |-> "idle"]
    /\ pGen = [p \in Probes |-> 0]
    /\ pTrust = [p \in Probes |-> 0]
    /\ pInst = [p \in Probes |-> 0]
    /\ pLatch = [p \in Probes |-> 0]
    /\ served = NoServed

(***************************************************************************)
(* The latch's own helpers.                                                *)
(***************************************************************************)

\* clearVerdict. owed, lTrust and lInst are not touched.
ClearV(L) == [L EXCEPT !.v = "none", !.cool = FALSE, !.icool = FALSE,
                       !.att = 0]

\* settleTrustGeneration(g): a verdict of another trust generation is
\* dropped. Without ReadChecksTrust (before #4530) there is no such check.
SettleTrust(L, g) ==
    IF ~ReadChecksTrust \/ L.lTrust = g THEN L
    ELSE [ClearV(L) EXCEPT !.lTrust = g]

\* syncInstallGeneration: a new install generation drops the attempts and
\* the install cooldown, or the whole verdict when it is the exhausted one.
SyncInst(L) ==
    IF L.lInst = instGen THEN L
    ELSE IF L.v = "exh" THEN [ClearV(L) EXCEPT !.lInst = instGen]
    ELSE [L EXCEPT !.lInst = instGen, !.att = 0, !.icool = FALSE]

\* read(), up to the answer: "T" and "F" are served, "N" owes a probe.
Answer(L) ==
    IF L.v = "avail" THEN "T"
    ELSE IF L.v = "prov" THEN (IF L.cool \/ L.icool THEN "T" ELSE "N")
    ELSE IF L.v = "none" THEN "N"
    ELSE IF L.v = "trans" THEN (IF L.cool \/ L.icool THEN "F" ELSE "N")
    ELSE "F"

\* owe(null): the first null read since the last note remembers its trust
\* (`??=`). With TrustStamp "lastRead" a later null read, such as a caller
\* joining the probe in flight, overwrites it.
Owe(L) ==
    IF L.owed = NoOwed \/ TrustStamp = "lastRead"
    THEN [L EXCEPT !.owed = L.lTrust]
    ELSE L

(***************************************************************************)
(* The owner's ensure: the first touch after a session start clears.       *)
(***************************************************************************)
Ensured ==
    IF Clear = "touch" /\ latchGen # avGen
    THEN [latchGen |-> avGen, flight |-> 0, lat |-> FreshLatch,
          curLatch |-> IF NewLatchPerGen THEN curLatch + 1 ELSE curLatch]
    ELSE [latchGen |-> latchGen, flight |-> flight, lat |-> lat,
          curLatch |-> curLatch]

(***************************************************************************)
(* Actions.                                                                *)
(***************************************************************************)

SessionStart ==
    /\ avGen < MaxGen
    /\ avGen' = avGen + 1
    /\ instGen' = instGen + 1
    /\ UNCHANGED <<trustGen, latchGen, curLatch, flight, lat, started, pc,
                   pGen, pTrust, pInst, pLatch, served>>

TrustAdopt ==
    /\ trustGen < MaxTrust
    /\ trustGen' = trustGen + 1
    /\ UNCHANGED <<avGen, instGen, latchGen, curLatch, flight, lat, started,
                   pc, pGen, pTrust, pInst, pLatch, served>>

ExpireCooldown ==
    /\ lat.cool \/ lat.icool
    /\ lat' = [lat EXCEPT !.cool = FALSE, !.icool = FALSE]
    /\ UNCHANGED <<avGen, trustGen, instGen, latchGen, curLatch, flight,
                   started, pc, pGen, pTrust, pInst, pLatch, served>>

\* A caller: ensure, read(), then serve, join, or start a probe.
Call ==
    LET e == Ensured
        L0 == SyncInst(SettleTrust(e.lat, trustGen))
        a == Answer(L0)
        L1 == IF a = "N" THEN Owe(L0) ELSE L0
    IN /\ latchGen' = e.latchGen
       /\ curLatch' = e.curLatch
       /\ lat' = L1
       /\ \/ \* served from the latch
             /\ a # "N"
             /\ flight' = e.flight
             /\ served' = [ok |-> TRUE, vTrust |-> L0.vTrust, trust |-> trustGen,
                           vGen |-> L0.vGen, gen |-> avGen]
             /\ UNCHANGED <<started, pc, pGen, pTrust, pInst, pLatch>>
          \/ \* joins the probe in flight
             /\ a = "N" /\ e.flight # 0
             /\ flight' = e.flight
             /\ UNCHANGED <<started, pc, pGen, pTrust, pInst, pLatch, served>>
          \/ \* starts a probe, capturing the generations it runs under
             /\ a = "N" /\ e.flight = 0 /\ started < MaxProbes
             /\ started' = started + 1
             /\ flight' = started + 1
             /\ pc' = [pc EXCEPT ![started + 1] = "run"]
             /\ pGen' = [pGen EXCEPT ![started + 1] = avGen]
             /\ pTrust' = [pTrust EXCEPT ![started + 1] = trustGen]
             /\ pInst' = [pInst EXCEPT ![started + 1] = instGen]
             /\ pLatch' = [pLatch EXCEPT ![started + 1] = e.curLatch]
             /\ UNCHANGED served
       /\ UNCHANGED <<avGen, trustGen, instGen>>

\* The note a settling probe makes: settleNote, then the note's own fields.
Note(L, p, r) ==
    LET stamp == IF TrustStamp = "current" THEN trustGen
                 ELSE IF L.owed # NoOwed THEN L.owed ELSE L.lTrust
        S == [SettleTrust(L, stamp) EXCEPT !.owed = NoOwed]
        W == [S EXCEPT !.vGen = pGen[p], !.vTrust = pTrust[p],
                       !.vInst = pInst[p]]
        Y == SyncInst(W)
    IN IF r = "ok"
       THEN [W EXCEPT !.v = "avail", !.cool = FALSE, !.icool = FALSE,
                      !.att = 0, !.lInst = instGen]
       ELSE IF r = "prov"
       THEN [Y EXCEPT !.v = "prov", !.cool = TRUE, !.icool = FALSE,
                      !.att = 0]
       ELSE IF r = "trans"
       THEN [Y EXCEPT !.v = "trans", !.cool = TRUE]
       ELSE IF r = "inst"
       THEN IF Y.att + 1 > Ladder
            THEN [Y EXCEPT !.v = "exh", !.cool = FALSE, !.icool = FALSE,
                           !.att = Y.att + 1]
            ELSE [Y EXCEPT !.v = "trans", !.icool = TRUE, !.att = Y.att + 1]
       ELSE [Y EXCEPT !.v = "dur", !.cool = FALSE, !.icool = FALSE]

\* A probe settles. The write reaches the live latch only when the probe
\* holds the live object and the guard, if any, admits it. The flight slot
\* is released by identity.
Settle(p, r) ==
    /\ pc[p] = "run"
    /\ r \in Results
    /\ LET target == IF NewLatchPerGen THEN pLatch[p] ELSE curLatch
           lands == target = curLatch
                    /\ (SettleGuard = "none" \/ pGen[p] = avGen)
       IN lat' = IF lands THEN Note(lat, p, r) ELSE lat
    /\ flight' = IF flight = p THEN 0 ELSE flight
    /\ pc' = [pc EXCEPT ![p] = "done"]
    /\ UNCHANGED <<avGen, trustGen, instGen, latchGen, curLatch, started,
                   pGen, pTrust, pInst, pLatch, served>>

Next ==
    \/ SessionStart
    \/ TrustAdopt
    \/ ExpireCooldown
    \/ Call
    \/ \E p \in Probes, r \in Results : Settle(p, r)

Spec == Init /\ [][Next]_vars

(***************************************************************************)
(* Invariants.                                                             *)
(***************************************************************************)

(* The #5333 invariant: only the generation that started a probe may      *)
(* record its verdict. Once the owner has cleared for the current avGen,   *)
(* every verdict it holds was written by a probe started in that           *)
(* generation. A verdict from before the session start that the owner has  *)
(* not touched yet is not a violation: nothing can read it, the next touch *)
(* clears it.                                                              *)
OnlyStarterRecords ==
    (latchGen = avGen /\ lat.v # "none") => lat.vGen = avGen

(* The user-visible side: a read never answers with a verdict a probe of an *)
(* older generation wrote.                                                  *)
NoStaleServed ==
    served.ok => served.vGen = served.gen

(* #4776: a note never stamps a verdict with a trust generation newer than  *)
(* the one its probe started under. The stamp may be older; the next read   *)
(* drops the verdict and the caller probes again.                           *)
StampNotNewer ==
    lat.v # "none" => lat.lTrust <= lat.vTrust

(* #4530: a read never answers with a verdict computed under another trust  *)
(* generation than the current one.                                         *)
ServedUnderTrust ==
    served.ok => served.vTrust = served.trust

(* The install-class attempts and the exhausted verdict belong to the       *)
(* install generation the latch is synced to: a probe from an older install *)
(* generation neither counts as an attempt nor arms a cooldown in the       *)
(* newer one (#1497 review F1 is the session-scope half of this).          *)
InstallOwned ==
    (lat.att > 0 \/ lat.v = "exh") => lat.vInst = lat.lInst

=============================================================================
