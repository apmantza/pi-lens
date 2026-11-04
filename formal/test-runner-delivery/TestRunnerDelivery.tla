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
(*    writes, so only g = launched publishes. A stage that finds the host *)
(*    idle marks the delivery eligible at once (#5259 review F2);         *)
(*  - Settle: agent_settled. The host is idle; deliverTestRunnerFindings   *)
(*    marks the pending delivery eligible and persists the marker, or     *)
(*    drops it as superseded;                                              *)
(*  - Prompt: the next prompt's context build. consumeStaged... delivers  *)
(*    an eligible delivery whose identity still matches, rehydrating it   *)
(*    from the marker after a restart, and retires the content;           *)
(*  - Build: a later context build of the same run, through the same      *)
(*    consume;                                                             *)
(*  - Restart: a primary session replacement clears the in-memory map.    *)
(*                                                                         *)
(* Identity is the generation a delivery compares with its own:           *)
(*  "content" (shipped, #5259), "launch" (pre-fix: testRunGeneration),    *)
(*  "none" (mutant: no comparison).                                        *)
(* StageEligible is what a publish does with the host's idle state:       *)
(*  "idle" (shipped: eligible when the host is idle), "never" (before the *)
(*  round: only the settle marks), "always" (mutant: no idle read).       *)
(*                                                                         *)
(* Invariants:                                                             *)
(*  - NoLateDelivery: failing content this key published, and that no     *)
(*    newer content or a restart before eligibility took away, is         *)
(*    delivered at the next prompt (#5259: it waited a whole agent run,   *)
(*    whether it published before or after the settle);                   *)
(*  - NoStaleDelivery: a delivery never hands over content another        *)
(*    generation published;                                                *)
(*  - NoMidRunDelivery: a context build inside a run never delivers       *)
(*    (#2366: the result reaches the model at a prompt, not mid-work).    *)
(***************************************************************************)
EXTENDS Naturals

CONSTANTS
    MaxGen,        \* bound on launches
    Identity,      \* "content" | "launch" | "none"
    StageEligible  \* "idle" | "never" | "always"

VARIABLES
    launched,   \* testRunGeneration
    content,    \* generation of the record's content, 0 = retired/empty
    inflight,   \* launched batches not yet published
    pendingGen, \* in-memory pending delivery's generation, 0 = none
    eligible,   \* in-memory pending delivery is eligible
    marker,     \* persisted deliveryEligible.generation, 0 = none
    idle,       \* the host is idle (between agent_settled and the next prompt)
    owed,       \* own content still owed to the model, 0 = none
    late,       \* NoLateDelivery broke
    stale,      \* NoStaleDelivery broke
    midrun      \* NoMidRunDelivery broke

vars == <<launched, content, inflight, pendingGen, eligible, marker, idle,
          owed, late, stale, midrun>>

Gens == 0..MaxGen

TypeOK ==
    /\ launched \in Gens
    /\ content \in Gens
    /\ inflight \subseteq 1..MaxGen
    /\ pendingGen \in Gens
    /\ eligible \in BOOLEAN
    /\ marker \in Gens
    /\ idle \in BOOLEAN
    /\ owed \in Gens
    /\ late \in BOOLEAN
    /\ stale \in BOOLEAN
    /\ midrun \in BOOLEAN

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
    /\ owed = 0
    /\ late = FALSE
    /\ stale = FALSE
    /\ midrun = FALSE

\* turn_end pre-run write: bump the high-water mark, keep content and marker.
Launch ==
    /\ ~idle
    /\ launched < MaxGen
    /\ launched' = launched + 1
    /\ inflight' = inflight \cup {launched + 1}
    /\ UNCHANGED <<content, pendingGen, eligible, marker, idle, owed, late,
                   stale, midrun>>

\* The newest batch publishes failing content (any time). `own`: it stages
\* under this delivery's key; otherwise another activation or session on the
\* same cwd launched it, and the record changes under this key's delivery.
\* An own stage that reads the host idle runs the settle's marking at once.
Publish ==
    /\ launched \in inflight
    /\ inflight' = inflight \ {launched}
    /\ content' = launched
    /\ \E own \in BOOLEAN :
        IF own
          THEN LET now == \/ StageEligible = "always"
                          \/ StageEligible = "idle" /\ idle
               IN /\ pendingGen' = launched
                  /\ eligible' = now
                  /\ marker' = IF now THEN launched ELSE 0
                  /\ owed' = launched
          ELSE /\ marker' = 0
               /\ owed' = 0
               /\ UNCHANGED <<pendingGen, eligible>>
    /\ UNCHANGED <<launched, idle, late, stale, midrun>>

\* An older batch finishes after a newer launch: it is superseded, no write.
DropOlder ==
    /\ \E g \in inflight :
        /\ g < launched
        /\ inflight' = inflight \ {g}
    /\ UNCHANGED <<launched, content, pendingGen, eligible, marker, idle,
                   owed, late, stale, midrun>>

\* agent_settled: mark eligible (with the content recheck) or drop.
Settle ==
    /\ ~idle
    /\ idle' = TRUE
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
    /\ UNCHANGED <<launched, content, inflight, owed, late, stale, midrun>>

\* A same-session restart clears the in-memory map; the marker survives. A
\* delivery that was not yet eligible is lost by design (#2366): it is no
\* longer owed.
Restart ==
    /\ pendingGen # 0
    /\ pendingGen' = 0
    /\ eligible' = FALSE
    /\ owed' = IF eligible THEN owed ELSE 0
    /\ UNCHANGED <<launched, content, inflight, marker, idle, late, stale,
                   midrun>>

\* consumeStagedTestRunnerFindings at a context build. `first`: the build
\* that starts the next prompt; otherwise a later build of the same run.
Consume(first) ==
    LET g == IF pendingGen # 0 THEN pendingGen ELSE marker
        ok == eligible \/ (pendingGen = 0 /\ marker # 0)
        deliver == content # 0 /\ g # 0 /\ ok /\ Matches(g)
    IN /\ IF deliver
            THEN /\ content' = 0
                 /\ marker' = 0
                 /\ owed' = 0
                 /\ stale' = (stale \/ g # content)
            ELSE UNCHANGED <<content, marker, owed, stale>>
       /\ pendingGen' = IF ok THEN 0 ELSE pendingGen
       /\ eligible' = FALSE
       /\ late' = (late \/ (first /\ ~deliver /\ owed # 0))
       /\ midrun' = (midrun \/ (~first /\ deliver))

\* The next prompt's context build (the host leaves idle).
Prompt ==
    /\ idle
    /\ idle' = FALSE
    /\ Consume(TRUE)
    /\ UNCHANGED <<launched, inflight>>

\* A later context build inside the run.
Build ==
    /\ ~idle
    /\ Consume(FALSE)
    /\ UNCHANGED <<launched, inflight, idle>>

Next ==
    \/ Launch
    \/ Publish
    \/ DropOlder
    \/ Settle
    \/ Restart
    \/ Prompt
    \/ Build

Spec == Init /\ [][Next]_vars

NoLateDelivery == ~late
NoStaleDelivery == ~stale
NoMidRunDelivery == ~midrun

=============================================================================
