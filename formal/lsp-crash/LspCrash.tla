------------------------------ MODULE LspCrash ------------------------------
(***************************************************************************)
(* An LSP server process dying while touches of one file are in flight,    *)
(* and the lazy respawn that follows (clients/lsp/index.ts,                *)
(* clients/lsp/client.ts). Issues #3501 and #3502; see README.md.          *)
(*                                                                         *)
(* Actors:                                                                 *)
(*  - the server process of the current client generation. It may crash   *)
(*    at any step (Crash). The client's connection onClose/onError/'exit'  *)
(*    handlers flip isConnected/isDestroyed in the same tick, so           *)
(*    isClientAlive() is false from then on (setupConnectionLifecycle).    *)
(*    Nothing resolves the client's pending waiters early; the registry    *)
(*    entry stays until the next attach notices it;                        *)
(*  - capacity eviction (makeCapacityForClient): shuts down                *)
(*    an idle client with no lease and deletes it from the registry;       *)
(*  - touches of the one file (LSPService.touchFile), sequential or        *)
(*    concurrent, with the same content:                                   *)
(*      "sync"    - the pipeline's lsp_sync touch, no diagnostics;         *)
(*      "collect" - the dispatch runner's collecting touch.                *)
(*    Each is: Acquire (getClientForFile -> ensureClientForServer, which   *)
(*    detects a dead client, runs the breaker and respawns, then takes a   *)
(*    lease), Decide (shouldSkipNotify, which reads the                    *)
(*    per-(path,scope,serverId) recentTouches entry), Write (notify.open), *)
(*    Mark (markTouched after the write resolves `true`), then for         *)
(*    "collect": Wait (waitForDiagnostics, bounded by its timeout) and the *)
(*    verdict, where a silentOnClean server's timed-out silence is         *)
(*    confirmed clean if pingLiveness() answers (the #799 gate);           *)
(*  - the language server of each generation: once it holds the document  *)
(*    it publishes the file's (non-empty) diagnostics.                     *)
(*                                                                         *)
(* The file is DIRTY: any "clean" verdict is false.                        *)
(***************************************************************************)
EXTENDS Integers, Sequences, FiniteSets

CONSTANTS
    Shape,          \* the touch sequence, one letter per touch: "S" = sync, "C" = collect
    Concurrent,     \* touches may overlap (FALSE: each starts after the previous ends)
    Silent,         \* the server is silentOnClean (marksman, lua): tier3 confirm applies
    MaxCrashes,     \* crashes the model may inject
    Uptimes,        \* subset of {"early","mid","long"}: lifetime class of a crash
    MaxEvicts,      \* capacity evictions the model may inject
    LeaseCheck,     \* eviction skips a leased client (FALSE = mutant)
    PingGuard,      \* the silent-clean confirm requires pingLiveness() (FALSE = mutant)
    WaitTimeout,    \* waitForDiagnostics has its own timeout (FALSE = mutant)
    FastPath,       \* #1127 consecutive early-exit breaker (FALSE = mutant)
    WindowTrip,     \* #1142 windowed runtime-exit breaker (FALSE = mutant)
    ClearReadyOnDeath, \* the dead-client branch deletes demonstratedReady/Cold
                       \* (TRUE = code since #3502; FALSE = the pre-#3502 code)
    ColdGuard,      \* a warm-up caches demonstratedCold only while the client it
                    \* judged, or the absence of one, is still what is
                    \* registered (TRUE = code since #3502's verify round 2;
                    \* FALSE = mutant)
    RegClear,       \* registering a client forgets the key's readiness verdicts
                    \* (TRUE = code since #3502's verify round 3; FALSE = mutant:
                    \* a no-client cold verdict outlives the first spawn)
    ReadyGuard,     \* a touch marks demonstratedReady only while its client is
                    \* still the registered one (TRUE = code since #3502's review
                    \* round 1; FALSE = mutant: a dead client's late answer marks
                    \* the key its replacement now holds)
    Trip,           \* BROKEN_PERMANENT_AFTER = RUNTIME_EXIT_WINDOW_TRIP_COUNT (5 in code)
    Fix             \* "bind" (code since #3501: an entry is valid only for the
                    \* client instance it was written to), "none" (the
                    \* pre-#3501 code: no client identity), "clear" (entry
                    \* deleted when a dead client is detected and when a client
                    \* is evicted), "clearDeath" (deleted on dead-client
                    \* detection only), "clearDeadFalse" ("clear" plus a dead
                    \* client's notify resolving false)

\* "S" sync, "C" collect, "W" ensureWarmForSweep's warm-up touch: it waits
\* for a verdict, and a failed one caches the key cold (demonstratedCold).
Kinds == [k \in 1..Len(Shape) |->
            CASE SubSeq(Shape, k, k) = "S" -> "sync"
              [] SubSeq(Shape, k, k) = "W" -> "warmup"
              [] OTHER -> "collect"]
N == Len(Shape)
T == 1..N
MaxGen == MaxCrashes + MaxEvicts
Gens == 0..MaxGen
None == -1

VARIABLES
    gen,        \* generation of the newest client in the registry
    registry,   \* "live" | "dead" (crashed, not yet detected) | "empty"
    held,       \* [Gens -> BOOLEAN] that generation's server holds the document
    pub,        \* [Gens -> BOOLEAN] that generation's client cache has its publish
    rt,         \* recentTouches entry: None, or the generation whose write marked it
    crashes, evicts,
    uptime,     \* lifetime class of the undetected death
    earlyStreak, windowDeaths, permBroken, cooling,
    loopRespawns,   \* ghost: respawns that followed an early/mid death
    ready, readyGen,  \* demonstratedReady for the server key, and (ghost) which generation earned it
    cold, coldGen,    \* demonstratedCold for the server key, and (ghost) which generation it judged
    pc, tg, skip, wrote, verdict,
    evictUnderLease

vars == <<gen, registry, held, pub, rt, crashes, evicts, uptime, earlyStreak,
          windowDeaths, permBroken, cooling, loopRespawns, ready, readyGen, cold, coldGen,
          pc, tg, skip, wrote, verdict, evictUnderLease>>

Init ==
    /\ gen = 0 /\ registry = "live"
    /\ held = [g \in Gens |-> FALSE] /\ pub = [g \in Gens |-> FALSE]
    /\ rt = None
    /\ crashes = 0 /\ evicts = 0 /\ uptime = "none"
    /\ earlyStreak = 0 /\ windowDeaths = 0 /\ permBroken = FALSE /\ cooling = FALSE
    /\ loopRespawns = 0
    /\ ready = FALSE /\ readyGen = None
    /\ cold = FALSE /\ coldGen = None
    /\ pc = [i \in T |-> "idle"]
    /\ tg = [i \in T |-> None]
    /\ skip = [i \in T |-> FALSE]
    /\ wrote = [i \in T |-> FALSE]
    /\ verdict = [i \in T |-> "none"]
    /\ evictUnderLease = FALSE

Live(g) == registry = "live" /\ gen = g
Leased == \E i \in T : pc[i] \in {"decide", "write", "mark", "wait", "gate"}
Touching == <<pc, tg, skip, wrote, verdict>>
Breaker == <<earlyStreak, windowDeaths, permBroken, cooling, loopRespawns>>

-----------------------------------------------------------------------------
\* The server process dies (SIGKILL, OOM, a crash on the new content).
Crash ==
    /\ registry = "live" /\ crashes < MaxCrashes
    /\ registry' = "dead"
    /\ crashes' = crashes + 1
    /\ \E u \in Uptimes : uptime' = u
    /\ UNCHANGED <<gen, held, pub, rt, evicts, Breaker, ready, readyGen, cold, coldGen,
                   Touching, evictUnderLease>>

\* makeCapacityForClient: an idle, unleased client is shut down and removed.
\* Deletes demonstratedReady/demonstratedCold, like every retirement path.
Evict ==
    /\ registry = "live" /\ evicts < MaxEvicts
    /\ LeaseCheck => ~Leased
    /\ registry' = "empty"
    /\ evicts' = evicts + 1
    /\ evictUnderLease' = (evictUnderLease \/ Leased)
    /\ ready' = FALSE /\ readyGen' = None
    /\ cold' = FALSE /\ coldGen' = None
    /\ rt' = IF Fix \in {"clear", "clearDeadFalse"} THEN None ELSE rt
    /\ UNCHANGED <<gen, held, pub, crashes, uptime, Breaker, Touching>>

\* The breaker cooldown lapses (state.broken entry in the past).
CooldownExpire ==
    /\ cooling /\ ~permBroken
    /\ cooling' = FALSE
    /\ UNCHANGED <<gen, registry, held, pub, rt, crashes, evicts, uptime,
                   earlyStreak, windowDeaths, permBroken, loopRespawns, ready,
                   readyGen, cold, coldGen, Touching, evictUnderLease>>

\* The TOUCH_DEBOUNCE_MS window of the recentTouches entry elapses.
RtExpire ==
    /\ rt # None
    /\ rt' = None
    /\ UNCHANGED <<gen, registry, held, pub, crashes, evicts, uptime, Breaker,
                   ready, readyGen, cold, coldGen, Touching, evictUnderLease>>

\* The server of generation g publishes the file's diagnostics.
Publish(g) ==
    /\ Live(g) /\ held[g] /\ ~pub[g]
    /\ pub' = [pub EXCEPT ![g] = TRUE]
    /\ UNCHANGED <<gen, registry, held, rt, crashes, evicts, uptime, Breaker,
                   ready, readyGen, cold, coldGen, Touching, evictUnderLease>>

-----------------------------------------------------------------------------
\* Touch i may start.
CanStart(i) ==
    /\ pc[i] = "idle"
    /\ ~Concurrent => \A j \in T : j < i => pc[j] = "done"

\* ensureClientForServer's dead-client branch for a
\* non-intentional death with lifetime u.
\*   window (#1142): u <= RUNTIME_EXIT_WINDOW_UPTIME_CEILING_MS is recorded;
\*     at Trip recorded deaths -> permanentlyBroken. Ageing out of the 15 min
\*     window is not modelled.
\*   fast path (#1127): u < 60s -> streak+1, cooldown; at Trip -> permanent.
\*     Otherwise the streak resets.
NewWindow(u) == IF WindowTrip /\ u \in {"early", "mid"} THEN windowDeaths + 1 ELSE windowDeaths
NewStreak(u) == IF FastPath THEN (IF u = "early" THEN earlyStreak + 1 ELSE 0) ELSE 0
NewPerm(u)   == permBroken \/ (WindowTrip /\ NewWindow(u) >= Trip)
                           \/ (FastPath /\ u = "early" /\ NewStreak(u) >= Trip)
NewCooling(u) == cooling \/ NewPerm(u) \/ (FastPath /\ u = "early")

\* Spawn a fresh client (generation gen+1) for touch i.
SpawnFor(i, countLoop) ==
    /\ gen' = gen + 1
    /\ registry' = "live"
    /\ tg' = [tg EXCEPT ![i] = gen + 1]
    /\ pc' = [pc EXCEPT ![i] = "decide"]
    /\ loopRespawns' = IF countLoop THEN loopRespawns + 1 ELSE loopRespawns

\* The ready mark after a touch's verdict. It runs after awaits, so a crash and
\* a concurrent respawn may land first; the guard is the code's
\* `this.state.clients.get(key) === entry.client` (registry entry of the same
\* generation, alive or not yet detected dead).
MarkReady(i) ==
    IF ~ReadyGuard \/ (registry # "empty" /\ gen = tg[i])
      THEN /\ ready' = TRUE /\ readyGen' = tg[i]
           \* markDemonstratedReadyKey: readiness supersedes a cold verdict.
           /\ cold' = FALSE /\ coldGen' = None
      ELSE UNCHANGED <<ready, readyGen, cold, coldGen>>

\* ensureWarmForSweep's cold cache after a failed warm-up, also after awaits;
\* the guard is the code's snapshot of the registered client
\* (`this.state.clients.get(key) === warmedClients[i]`).
MarkCold(i) ==
    /\ IF \/ ~ColdGuard
          \/ IF tg[i] = None THEN registry = "empty"
                             ELSE registry # "empty" /\ gen = tg[i]
         THEN cold' = TRUE /\ coldGen' = tg[i]
         ELSE UNCHANGED <<cold, coldGen>>
    /\ UNCHANGED <<ready, readyGen>>

Unavailable(i) ==
    /\ pc' = [pc EXCEPT ![i] = "done"]
    /\ verdict' = [verdict EXCEPT ![i] = "unavailable"]
    /\ UNCHANGED tg

Acquire(i) ==
    /\ CanStart(i)
    /\ CASE registry = "live" ->
              /\ tg' = [tg EXCEPT ![i] = gen]
              /\ pc' = [pc EXCEPT ![i] = "decide"]
              /\ UNCHANGED <<gen, registry, rt, uptime, Breaker, ready, readyGen, cold, coldGen, verdict>>
         [] registry = "dead" ->
              \* detection: breaker, then the state.broken check, then spawn.
              /\ earlyStreak' = NewStreak(uptime)
              /\ windowDeaths' = NewWindow(uptime)
              /\ permBroken' = NewPerm(uptime)
              /\ cooling' = NewCooling(uptime)
              /\ uptime' = "none"
              \* #3502: the branch deletes demonstratedReady like the other
              \* retirement paths (eviction, idle eviction, notify-stall
              \* demotion); before it, the replacement inherited it.
              /\ IF ClearReadyOnDeath
                   THEN /\ ready' = FALSE /\ readyGen' = None
                        /\ cold' = FALSE /\ coldGen' = None
                   ELSE UNCHANGED <<ready, readyGen, cold, coldGen>>
              /\ rt' = IF Fix \in {"clear", "clearDeath", "clearDeadFalse"} THEN None ELSE rt
              /\ IF NewCooling(uptime)
                   THEN /\ registry' = "empty" /\ Unavailable(i)
                        /\ UNCHANGED <<gen, loopRespawns>>
                   ELSE /\ SpawnFor(i, uptime \in {"early", "mid"})
                        /\ UNCHANGED verdict
         [] registry = "empty" ->
              /\ IF cooling
                   THEN /\ Unavailable(i) /\ UNCHANGED <<gen, registry, loopRespawns>>
                        /\ UNCHANGED <<ready, readyGen, cold, coldGen>>
                   ELSE /\ SpawnFor(i, FALSE) /\ UNCHANGED verdict
                        \* #3502 verify round 3: registration forgets a verdict
                        \* cached while no client was registered.
                        /\ IF RegClear
                             THEN /\ ready' = FALSE /\ readyGen' = None
                                  /\ cold' = FALSE /\ coldGen' = None
                             ELSE UNCHANGED <<ready, readyGen, cold, coldGen>>
              /\ UNCHANGED <<rt, uptime, earlyStreak, windowDeaths, permBroken,
                             cooling>>
    /\ UNCHANGED <<held, pub, crashes, evicts, skip, wrote, evictUnderLease>>

\* A warm-up that finds no client to ask (the key in its breaker cooldown, a
\* spawn that fails) fails its verdict for the absence of a client: #799's
\* negative cache holds the key cold until a client registers.
WarmupNoClient(i) ==
    /\ CanStart(i) /\ Kinds[i] = "warmup"
    /\ registry = "empty" /\ cooling
    /\ pc' = [pc EXCEPT ![i] = "done"]
    /\ verdict' = [verdict EXCEPT ![i] = "unavailable"]
    /\ MarkCold(i)
    /\ UNCHANGED <<gen, registry, held, pub, rt, crashes, evicts, uptime,
                   Breaker, tg, skip, wrote, evictUnderLease>>

\* shouldSkipNotify: the entry is within its window with the same fingerprint,
\* and (#3501, Fix = "bind") it was written by this touch's client instance.
Decide(i) ==
    /\ pc[i] = "decide"
    /\ skip' = [skip EXCEPT ![i] = (rt # None /\ (Fix = "bind" => rt = tg[i]))]
    /\ pc' = [pc EXCEPT ![i] = "write"]
    /\ UNCHANGED <<gen, registry, held, pub, rt, crashes, evicts, uptime, Breaker,
                   ready, readyGen, cold, coldGen, tg, wrote, verdict, evictUnderLease>>

\* notify.open. A skipped server is not written. A dead client resolves
\* `true` (handleNotifyOpen: `if (!isClientAlive(state)) return
\* Promise.resolve(true)`, and a queued entry whose runner sees the dead
\* client returns void, read as sent by `sent !== false`).
Write(i) ==
    /\ pc[i] = "write"
    /\ IF skip[i]
         THEN /\ wrote' = [wrote EXCEPT ![i] = FALSE]
              /\ UNCHANGED held
         ELSE IF Live(tg[i])
                THEN /\ held' = [held EXCEPT ![tg[i]] = TRUE]
                     /\ wrote' = [wrote EXCEPT ![i] = TRUE]
                ELSE /\ wrote' = [wrote EXCEPT ![i] = (Fix # "clearDeadFalse")]
                     /\ UNCHANGED held
    /\ pc' = [pc EXCEPT ![i] = "mark"]
    /\ UNCHANGED <<gen, registry, pub, rt, crashes, evicts, uptime, Breaker,
                   ready, readyGen, cold, coldGen, tg, skip, verdict, evictUnderLease>>

\* `if (wrote === true) markTouched(...)` - a later microtask than the write.
Mark(i) ==
    /\ pc[i] = "mark"
    /\ rt' = IF wrote[i] THEN tg[i] ELSE rt
    /\ pc' = [pc EXCEPT ![i] = IF Kinds[i] = "sync" THEN "done" ELSE "wait"]
    /\ UNCHANGED <<gen, registry, held, pub, crashes, evicts, uptime, Breaker,
                   ready, readyGen, cold, coldGen, tg, skip, wrote, verdict, evictUnderLease>>

\* The wait on client tg settles on its cache (a publish landed, possibly
\* before that client died: the dead client's cache is still read).
Answered(i) ==
    /\ pc[i] = "wait" /\ pub[tg[i]]
    /\ pc' = [pc EXCEPT ![i] = "done"]
    /\ verdict' = [verdict EXCEPT ![i] = "dirty"]
    /\ MarkReady(i)
    /\ UNCHANGED <<gen, registry, held, pub, rt, crashes, evicts, uptime,
                   Breaker, tg, skip, wrote, evictUnderLease>>

\* The wait's own timeout. Budget assumption: a live server that holds the
\* document publishes inside the budget (a slow-but-alive server is the
\* #799 design trade-off, not a crash defect).
TimeoutGuard(i) ==
    WaitTimeout /\ ~pub[tg[i]] /\ ~(Live(tg[i]) /\ held[tg[i]])

TimedOut(i) ==
    /\ pc[i] = "wait" /\ TimeoutGuard(i)
    /\ pc' = [pc EXCEPT ![i] = "gate"]
    /\ UNCHANGED <<gen, registry, held, pub, rt, crashes, evicts, uptime,
                   Breaker, ready, readyGen, cold, coldGen, tg, skip, wrote, verdict,
                   evictUnderLease>>

\* #799 silent-clean confirm: tier3-silent + pingLiveness() on the touch's
\* own client object (dead or shut down -> false: the client's pingLiveness).
Gate(i) ==
    /\ pc[i] = "gate"
    /\ LET confirm == Silent /\ (PingGuard => Live(tg[i]))
       IN /\ verdict' = [verdict EXCEPT ![i] = IF confirm THEN "clean" ELSE "inconclusive"]
          /\ IF confirm THEN MarkReady(i)
             ELSE IF Kinds[i] = "warmup" THEN MarkCold(i)
             ELSE UNCHANGED <<ready, readyGen, cold, coldGen>>
    /\ pc' = [pc EXCEPT ![i] = "done"]
    /\ UNCHANGED <<gen, registry, held, pub, rt, crashes, evicts, uptime,
                   Breaker, tg, skip, wrote, evictUnderLease>>

Next ==
    \/ Crash \/ Evict \/ CooldownExpire \/ RtExpire
    \/ \E g \in Gens : Publish(g)
    \/ \E i \in T : Acquire(i) \/ WarmupNoClient(i) \/ Decide(i) \/ Write(i) \/ Mark(i)
                    \/ Answered(i) \/ TimedOut(i) \/ Gate(i)

Spec == Init /\ [][Next]_vars

-----------------------------------------------------------------------------
TypeOK ==
    /\ gen \in Gens
    /\ registry \in {"live", "dead", "empty"}
    /\ rt \in Gens \cup {None}
    /\ pc \in [T -> {"idle", "decide", "write", "mark", "wait", "gate", "done"}]
    /\ verdict \in [T -> {"none", "clean", "dirty", "inconclusive", "unavailable"}]

\* A crash never turns into "confirmed clean". The file is dirty, so every
\* "clean" verdict is false.
NoFalseClean == \A i \in T : verdict[i] # "clean"

\* After a restart, pi-lens never believes a live server holds content it
\* was never sent: a touch that skipped its write (debounced) on a live
\* client is on one whose server holds the document. (A skip on the dead
\* client itself is harmless: its wait times out and its ping fails.)
SkipImpliesHeld ==
    \A i \in T : (skip[i] /\ pc[i] \in {"write", "mark", "wait", "gate", "done"}
                  /\ Live(tg[i]))
                 => held[tg[i]]

\* No waiter hangs: a touch waiting on its client can always leave the wait
\* (its publish is cached, or the timeout is armed and nothing can still
\* arrive), whatever happened to that client.
WaitBounded ==
    \A i \in T : pc[i] = "wait" =>
        (pub[tg[i]] \/ TimeoutGuard(i) \/ (Live(tg[i]) /\ held[tg[i]]))

\* A crash-looping server is bounded: at most Trip-1 respawns follow an
\* early or mid-life death (no window ageing modelled).
BoundedCrashLoop == loopRespawns < Trip

\* The key's demonstratedReady claim is about the client now in the registry.
ReadyIsCurrent == ready => (readyGen = gen /\ registry # "empty")

\* The key's demonstratedCold verdict is about the client now in the registry,
\* or about the absence of one while none is registered.
ColdIsCurrent == cold => (registry = "empty" \/ coldGen = gen)

\* Eviction never takes a client out from under an in-flight touch.
NoEvictUnderLease == ~evictUnderLease
=============================================================================
