--------------------------- MODULE RunnerStore ---------------------------
(***************************************************************************)
(* The deferred collect-later runner store (clients/dispatch/              *)
(* pending-runner-findings.ts) across a same-process session replacement. *)
(*                                                                         *)
(* Actors:                                                                 *)
(*  - deferRunnerFindings: the producer's admission. It fences with the    *)
(*    generation it captured (#3568), so an entry enters only from a live  *)
(*    scope or from a released writer with no captured handle (shape 57);  *)
(*  - drainPendingRunnerFindings: the turn-end reader. It removes the      *)
(*    settled answers it admits and keeps in-flight work for the store;    *)
(*  - peekSettledRunnerFindings: the commit gate's non-draining reader. It *)
(*    returns settled answers without removing them (#3814);               *)
(*  - requeueRunnerFindings: re-enters a drained, settled answer for the   *)
(*    next turn end when the delivery cap cut it (#3813). It tracks        *)
(*    unconditionally and carries entry.session, so the next reader can    *)
(*    still fence it;                                                     *)
(*  - a raw generation bump (a scope's retirement) with no store clear.    *)
(*    resetPendingRunnerFindings clears the store at session_start, so the *)
(*    window this model explores is the one before that clear, as #3824's  *)
(*    drain fence does.                                                    *)
(*                                                                         *)
(* An entry carries two identities: `producer`, the generation that        *)
(* actually computed the answer (0 = a released writer with no captured    *)
(* handle), and `owner`, the generation the fence reads off the entry. The *)
(* shipped code keeps them equal (settledSnapshot carries entry.session);  *)
(* a requeue that dropped it would leave owner 0 while producer stays 1.   *)
(*                                                                         *)
(* Invariants:                                                             *)
(*  - NoStaleAdmission (shape 54, safety): no reader admits an answer      *)
(*    whose producer scope has retired;                                    *)
(*  - NoDropFreshAnswer (shape 54, no-drop): no reader drops an answer     *)
(*    whose producer scope is live or has no captured handle.              *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS
    Slots,     \* the writers whose answers the store may hold
    Peek,      \* "owned"    the shipped commit-gate read (ownedByLiveSession)
               \* "unfenced" the pre-fix #3814 peek (no admission check)
               \* "none"     over-drop mutant: the read admits nothing
    Drain,     \* "owned" | "unfenced" | "none" (the turn-end reader)
    Requeue,   \* "carry" (shipped) | "drop" (the snapshot loses entry.session)
    NoHandle   \* "admit" (shipped) | "drop" (mutant: a released writer is fenced out)

VARIABLES
    phase,      \* "s1" | "s2"
    gen,        \* the current generation
    producer,   \* [Slots -> 0..2]: the generation that computed the answer
    owner,      \* [Slots -> 0..2]: the generation the fence reads
    pending,    \* entries the store holds
    settled,    \* pending entries whose answer has arrived
    delivered,  \* entries a drain removed and admitted
    leaked,     \* a reader admitted an answer whose producer has retired
    droppedLive \* a reader dropped an answer whose producer is live/unfenced

vars == <<phase, gen, producer, owner, pending, settled, delivered, leaked,
          droppedLive>>

TypeOK ==
    /\ phase \in {"s1", "s2"}
    /\ gen \in 1..2
    /\ producer \in [Slots -> 0..2]
    /\ owner \in [Slots -> 0..2]
    /\ pending \subseteq Slots
    /\ settled \subseteq Slots
    /\ delivered \subseteq Slots
    /\ leaked \in BOOLEAN
    /\ droppedLive \in BOOLEAN

\* The producer's scope has retired: the answer belongs to an earlier session.
TrueRetired(s) == producer[s] # 0 /\ producer[s] # gen

\* The producer's scope is live, or it is a released writer with no handle.
Fresh(s) == ~TrueRetired(s)

\* The fence the reader applies, reading the owner the entry carries.
ReaderAdmits(kind, s) ==
    CASE kind = "unfenced" -> TRUE
      [] kind = "none"     -> FALSE
      [] OTHER             -> IF owner[s] = 0
                                THEN NoHandle = "admit"
                                ELSE owner[s] = gen

Init ==
    /\ phase = "s1"
    /\ gen = 1
    /\ producer = [s \in Slots |-> 0]
    /\ owner = [s \in Slots |-> 0]
    /\ pending = {}
    /\ settled = {}
    /\ delivered = {}
    /\ leaked = FALSE
    /\ droppedLive = FALSE

\* deferRunnerFindings: fenced at admission, so only a live capture or a
\* released writer with no handle enters the store.
Defer(s, o) ==
    /\ s \notin pending
    /\ (o = 0 \/ o = gen)
    /\ pending' = pending \cup {s}
    /\ settled' = settled \cup {s}
    /\ producer' = [producer EXCEPT ![s] = o]
    /\ owner' = [owner EXCEPT ![s] = o]
    /\ UNCHANGED <<phase, gen, delivered, leaked, droppedLive>>

\* requeueRunnerFindings: unconditional track of a drained settled answer.
\* It carries the producer's handle unless the "drop" mutant loses it.
RequeueTrack(s) ==
    /\ s \in delivered
    /\ pending' = pending \cup {s}
    /\ settled' = settled \cup {s}
    /\ owner' = [owner EXCEPT ![s] = IF Requeue = "carry" THEN owner[s] ELSE 0]
    /\ UNCHANGED <<phase, gen, producer, delivered, leaked, droppedLive>>

\* The commit gate's non-draining read. A fresh answer it filters out is a
\* no-drop failure; a retired answer it returns is a stale admission.
PeekRead ==
    /\ LET candidates == pending \cap settled
           admitted == {s \in candidates : ReaderAdmits(Peek, s)}
           rejected == candidates \ admitted
       IN /\ leaked' = (leaked \/ (\E s \in admitted : TrueRetired(s)))
          /\ droppedLive' = (droppedLive \/ (\E s \in rejected : Fresh(s)))
          /\ UNCHANGED <<phase, gen, producer, owner, pending, settled, delivered>>

\* The turn-end drain: it removes the settled answers it admits, drops the
\* settled ones whose fence rejects, and keeps in-flight work.
DrainRead ==
    /\ LET candidates == pending \cap settled
           admitted == {s \in candidates : ReaderAdmits(Drain, s)}
           rejected == candidates \ admitted
           inFlight == pending \ settled
       IN /\ pending' = inFlight
          /\ delivered' = delivered \cup admitted
          /\ leaked' = (leaked \/ (\E s \in admitted : TrueRetired(s)))
          /\ droppedLive' = (droppedLive \/ (\E s \in rejected : Fresh(s)))
    /\ UNCHANGED <<phase, gen, producer, owner, settled>>

\* A raw generation bump (the scope retires) without the session_start clear.
Retire ==
    /\ gen = 1
    /\ gen' = 2
    /\ phase' = "s2"
    /\ UNCHANGED <<producer, owner, pending, settled, delivered, leaked,
                   droppedLive>>

Next ==
    \/ (\E s \in Slots, o \in {0, gen} : Defer(s, o))
    \/ (\E s \in Slots : RequeueTrack(s))
    \/ PeekRead
    \/ DrainRead
    \/ Retire

Spec == Init /\ [][Next]_vars

(* Shape 54, safety: a reader never admits an answer whose producer retired. *)
NoStaleAdmission == ~leaked

(* Shape 54, no-drop: a reader never drops a live or unfenced answer. *)
NoDropFreshAnswer == ~droppedLive
=============================================================================
