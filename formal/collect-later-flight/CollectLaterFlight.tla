------------------------- MODULE CollectLaterFlight -------------------------
(***************************************************************************)
(* The collect-later run in flight for one (project, runner) key           *)
(* (clients/dispatch/collect-later-tier.ts `runCollectLater`, #5413).      *)
(*                                                                         *)
(* Actors:                                                                 *)
(*  - Write(f): a post-write dispatch of file f. With no flight it starts  *)
(*    a run and claims the key; with a flight it owes one rerun for f,     *)
(*    replacing any rerun already owed for f (the latest write wins);      *)
(*  - Settle(r): a run ends (success, failure, timeout and abort are one   *)
(*    transition here). Its continuation (`startQueued`) starts the next   *)
(*    owed rerun, or releases the key, but only while its flight still     *)
(*    owns the key;                                                        *)
(*  - Reset: session_start (`resetObservedRunnerLatency`). It drops the    *)
(*    claim and the owed reruns; runs already started keep running.        *)
(*                                                                         *)
(* A run reads the bytes of the version it was started for or later, so a *)
(* completed run of the current session covers that version.             *)
(*                                                                         *)
(* Invariants:                                                             *)
(*  - AtMostOneInFlight: at most one current-session run of the key is in *)
(*    flight (the #5413 pile-up was three);                                *)
(*  - NoLostWrite (shape 70): once the current session's flight is idle,  *)
(*    every file's latest write is covered by a run that started after it.*)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS
    Files,     \* the files written while the runner is slow
    MaxV,      \* writes per file per session
    Mode,      \* "flight" (shipped) | "parallel" (pre-#5413: a run per write)
               \* | "join" (a write shares the running run's answer)
    Identity   \* "check" (shipped: startQueued and chain compare the flight with the map)
               \* | "none" (a settling run releases whatever claim it finds)

VARIABLES
    gen,       \* the current session
    claim,     \* the session whose flight owns the key, 0 = none
    queue,     \* [Files -> 0..MaxV]: the version a rerun is owed for, 0 = none
    runs,      \* the runs in flight: [file, ver, g]
    written,   \* [Files -> 0..MaxV]: the latest write this session
    covered    \* [Files -> 0..MaxV]: the newest version a finished run covered

vars == <<gen, claim, queue, runs, written, covered>>

Run == [file: Files, ver: 1..MaxV, g: 1..2]

TypeOK ==
    /\ gen \in 1..2
    /\ claim \in 0..2
    /\ queue \in [Files -> 0..MaxV]
    /\ runs \subseteq Run
    /\ written \in [Files -> 0..MaxV]
    /\ covered \in [Files -> 0..MaxV]

Init ==
    /\ gen = 1
    /\ claim = 0
    /\ queue = [f \in Files |-> 0]
    /\ runs = {}
    /\ written = [f \in Files |-> 0]
    /\ covered = [f \in Files |-> 0]

Start(f, v, g) == runs' = runs \cup {[file |-> f, ver |-> v, g |-> g]}

Write(f) ==
    /\ written[f] < MaxV
    /\ LET v == written[f] + 1 IN
       /\ written' = [written EXCEPT ![f] = v]
       /\ CASE Mode = "parallel" ->
                 /\ Start(f, v, gen)
                 /\ UNCHANGED <<claim, queue>>
            [] Mode = "join" /\ claim = gen ->
                 \* shares the running run, which read older bytes
                 UNCHANGED <<claim, queue, runs>>
            [] claim = gen ->
                 /\ queue' = [queue EXCEPT ![f] = v]
                 /\ UNCHANGED <<claim, runs>>
            [] OTHER ->
                 /\ Start(f, v, gen)
                 /\ claim' = gen
                 /\ UNCHANGED queue
    /\ UNCHANGED <<gen, covered>>

Owed == {f \in Files : queue[f] > 0}

Settle(r) ==
    /\ r \in runs
    /\ covered' = IF r.g = gen /\ r.ver > covered[r.file]
                    THEN [covered EXCEPT ![r.file] = r.ver]
                    ELSE covered
    /\ IF Mode = "parallel" \/ (Identity = "check" /\ claim # r.g)
         THEN /\ runs' = runs \ {r}
              /\ UNCHANGED <<claim, queue>>
         ELSE IF Owed = {}
           THEN /\ runs' = runs \ {r}
                /\ claim' = 0
                /\ UNCHANGED queue
           ELSE \E f \in Owed :
                /\ runs' = (runs \ {r})
                           \cup {[file |-> f, ver |-> queue[f], g |-> gen]}
                /\ queue' = [queue EXCEPT ![f] = 0]
                /\ UNCHANGED claim
    /\ UNCHANGED <<gen, written>>

Reset ==
    /\ gen = 1
    /\ gen' = 2
    /\ claim' = 0
    /\ queue' = [f \in Files |-> 0]
    /\ written' = [f \in Files |-> 0]
    /\ covered' = [f \in Files |-> 0]
    /\ UNCHANGED runs

Next ==
    \/ \E f \in Files : Write(f)
    \/ \E r \in runs : Settle(r)
    \/ Reset

Spec == Init /\ [][Next]_vars

AtMostOneInFlight == Cardinality({r \in runs : r.g = gen}) <= 1

Idle == claim # gen /\ ~\E r \in runs : r.g = gen

NoLostWrite == Idle => \A f \in Files : covered[f] = written[f]
=============================================================================
