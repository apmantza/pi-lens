------------------------ MODULE TestRunnerDelivery ------------------------
(***************************************************************************)
(* Automatic test-runner delivery (clients/test-runner-delivery.ts) over  *)
(* the `test-runner-findings` record that turn_end writes                 *)
(* (clients/runtime-turn.ts). Issue #5259.                                *)
(*                                                                         *)
(* Three views of one fact: the in-memory pending delivery (generation,   *)
(* eligible), the persisted `deliveryEligible` marker, and the record's   *)
(* generations. The record carries two generations:                       *)
(*  - `launched`: `testRunGeneration`, the launch high-water mark. The     *)
(*    turn_end pre-run write bumps it and keeps the older batch's content; *)
(*  - `content`: the generation whose batch published the content          *)
(*    (`provenance.revision.generation`), 0 once a delivery retired it.    *)
(*                                                                         *)
(* Actors:                                                                 *)
(*  - Launch: the turn_end pre-run write (launched + 1, content kept,      *)
(*    marker kept);                                                        *)
(*  - Publish: the newest in-flight batch writes its failing content with  *)
(*    a fresh record (marker dropped) and stages its delivery. An older   *)
(*    batch is superseded by `supersededByNewerGeneration` and never      *)
(*    writes, so only g = launched publishes;                              *)
(*  - Settle: agent_settled. The host is idle; deliverTestRunnerFindings   *)
(*    marks the pending delivery eligible and persists the marker, or     *)
(*    drops it as superseded;                                              *)
(*  - Prompt: the next prompt's context build. consumeStaged... delivers  *)
(*    an eligible delivery whose identity still matches, rehydrating it   *)
(*    from the marker after a restart, and retires the content;           *)
(*  - Restart: a primary session replacement clears the in-memory map.    *)
(*                                                                         *)
(* Identity is the generation a delivery compares with its own:           *)
(*  "content" (shipped, #5259), "launch" (pre-fix: testRunGeneration),    *)
(*  "none" (mutant: no comparison).                                        *)
(*                                                                         *)
(* Invariants:                                                             *)
(*  - NoLateDelivery: content that was staged and pending when the host   *)
(*    settled, and is still the record's content at the next prompt, is  *)
(*    delivered at that prompt (#5259: it waited a whole agent run);      *)
(*  - NoStaleDelivery: a delivery never hands over content another        *)
(*    generation published.                                                *)
(***************************************************************************)
EXTENDS Naturals

CONSTANTS
    MaxGen,    \* bound on launches
    Identity   \* "content" | "launch" | "none"

VARIABLES
    launched,   \* testRunGeneration
    content,    \* generation of the record's content, 0 = retired/empty
    inflight,   \* launched batches not yet published
    pendingGen, \* in-memory pending delivery's generation, 0 = none
    eligible,   \* in-memory pending delivery is eligible
    marker,     \* persisted deliveryEligible.generation, 0 = none
    idle,       \* the host is idle (between agent_settled and the next prompt)
    seen,       \* content staged and pending at the last settle, 0 = none
    late,       \* NoLateDelivery broke
    stale       \* NoStaleDelivery broke

vars == <<launched, content, inflight, pendingGen, eligible, marker, idle,
          seen, late, stale>>

Gens == 0..MaxGen

TypeOK ==
    /\ launched \in Gens
    /\ content \in Gens
    /\ inflight \subseteq 1..MaxGen
    /\ pendingGen \in Gens
    /\ eligible \in BOOLEAN
    /\ marker \in Gens
    /\ idle \in BOOLEAN
    /\ seen \in Gens
    /\ late \in BOOLEAN
    /\ stale \in BOOLEAN

\* The generation the delivery compares with its own.
Current == IF Identity = "launch" THEN launched ELSE content

Matches(g) == Identity = "none" \/ Current = g

Init ==
    /\ launched = 0
    /\ content = 0
    /\ inflight = {}
    /\ pendingGen = 0
    /\ eligible = FALSE
    /\ marker = 0
    /\ idle = FALSE
    /\ seen = 0
    /\ late = FALSE
    /\ stale = FALSE

\* turn_end pre-run write: bump the high-water mark, keep content and marker.
Launch ==
    /\ ~idle
    /\ launched < MaxGen
    /\ launched' = launched + 1
    /\ inflight' = inflight \cup {launched + 1}
    /\ UNCHANGED <<content, pendingGen, eligible, marker, idle, seen, late,
                   stale>>

\* The newest batch publishes failing content (any time). `own`: it stages
\* under this delivery's key; otherwise another activation or session on the
\* same cwd launched it, and the record changes under this key's delivery.
Publish ==
    /\ launched \in inflight
    /\ inflight' = inflight \ {launched}
    /\ content' = launched
    /\ marker' = 0
    /\ \E own \in BOOLEAN :
        IF own
          THEN /\ pendingGen' = launched
               /\ eligible' = FALSE
          ELSE UNCHANGED <<pendingGen, eligible>>
    /\ UNCHANGED <<launched, idle, seen, late, stale>>

\* An older batch finishes after a newer launch: it is superseded, no write.
DropOlder ==
    /\ \E g \in inflight :
        /\ g < launched
        /\ inflight' = inflight \ {g}
    /\ UNCHANGED <<launched, content, pendingGen, eligible, marker, idle,
                   seen, late, stale>>

\* agent_settled: mark eligible (with the content recheck) or drop.
Settle ==
    /\ ~idle
    /\ idle' = TRUE
    /\ seen' = IF pendingGen # 0 /\ pendingGen = content THEN content ELSE 0
    /\ IF pendingGen = 0
         THEN UNCHANGED <<pendingGen, eligible, marker>>
       ELSE IF Identity # "none" /\ Current > pendingGen
         THEN /\ pendingGen' = 0
              /\ eligible' = FALSE
              /\ UNCHANGED marker
       ELSE IF content # 0 /\ Matches(pendingGen)
         THEN /\ eligible' = TRUE
              /\ marker' = pendingGen
              /\ UNCHANGED pendingGen
       ELSE /\ pendingGen' = 0
            /\ eligible' = FALSE
            /\ UNCHANGED marker
    /\ UNCHANGED <<launched, content, inflight, late, stale>>

\* A same-session restart clears the in-memory map; the marker survives.
Restart ==
    /\ pendingGen # 0
    /\ pendingGen' = 0
    /\ eligible' = FALSE
    /\ UNCHANGED <<launched, content, inflight, marker, idle, seen, late,
                   stale>>

\* The next prompt's context build (the host leaves idle).
Prompt ==
    /\ idle
    /\ idle' = FALSE
    /\ LET g == IF pendingGen # 0 THEN pendingGen ELSE marker
           ok == eligible \/ (pendingGen = 0 /\ marker # 0)
           deliver == content # 0 /\ g # 0 /\ ok /\ Matches(g)
       IN /\ IF deliver
               THEN /\ content' = 0
                    /\ marker' = 0
                    /\ stale' = (stale \/ g # content)
               ELSE /\ UNCHANGED <<content, marker, stale>>
          /\ pendingGen' = IF ok THEN 0 ELSE pendingGen
          /\ eligible' = FALSE
          /\ late' = (late \/ (~deliver /\ seen # 0 /\ seen = content))
    /\ seen' = 0
    /\ UNCHANGED <<launched, inflight>>

Next ==
    \/ Launch
    \/ Publish
    \/ DropOlder
    \/ Settle
    \/ Restart
    \/ Prompt

Spec == Init /\ [][Next]_vars

NoLateDelivery == ~late
NoStaleDelivery == ~stale

=============================================================================
