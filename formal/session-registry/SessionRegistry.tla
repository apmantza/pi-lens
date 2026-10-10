--------------------------- MODULE SessionRegistry ---------------------------
(***************************************************************************)
(* The instance registry entry of ONE pi process across a session          *)
(* replacement (#3498): session 1 serves root "A", ends (session_shutdown), *)
(* and session 2 starts in the same process serving root "B" (pi's         *)
(* switchSession re-creates the runtime with the resumed session's cwd).   *)
(*                                                                         *)
(* Actors:                                                                 *)
(*  - the host: session_start -> `void registerInstance(cwd)`, queued on   *)
(*    the process-wide mutation tail; session_shutdown ->                  *)
(*    `deregisterInstance()`, which clears the registration intent and     *)
(*    removes the entry with a SYNC lock that bypasses the tail;           *)
(*  - the mutation tail (queueRegistryMutation): registerInstanceNow sets  *)
(*    the intent (rememberRegistrationRoot) BEFORE taking the lock, then   *)
(*    read-modify-writes the entry under the async lock;                   *)
(*  - an LSP spawn per session (`void recordLspChild(...)`, lsp/client.ts),*)
(*    queued on the tail: with no entry it synthesizes one carrying the    *)
(*    session's root as a service cwd;                                     *)
(*  - a declined secondary per session: its start queues                  *)
(*    `registerInstanceRoot` (adds the secondary's root to an existing     *)
(*    entry, never creates one) and its shutdown queues                    *)
(*    `deregisterInstanceRoot`: while the entry still holds the session's  *)
(*    root it re-arms the intent to that root. With RootRemoval # "off"    *)
(*    the secondary's own root (T1, T2) is a member of the entry and the   *)
(*    removal drops it (#3587, #3657, #3703);                              *)
(*  - a heartbeat per session (updateHeartbeat; turn_end and the           *)
(*    agent_settled quiet window, both fire-and-forget): under the async   *)
(*    lock it notes whether the entry is missing; after the lock it        *)
(*    re-registers from the intent (#3447), queued, not awaited;           *)
(*  - another pi process that can hold the machine-wide lock.              *)
(*                                                                         *)
(* The lock is not re-entrant (generation-lock.ts): the sync deregister    *)
(* meets this process's own async hold as "busy", and Atomics.wait blocks  *)
(* the event loop, so the holder cannot release. A sync removal that sees  *)
(* an own async hold in flight skips the LOCK_WAIT_MS spin and gives up at *)
(* once (instance-registry-lock-own-hold); one that meets a peer's hold    *)
(* gives up after LOCK_WAIT_MS. Both end in the same state, so the model   *)
(* does not tell them apart (time is over-approximated).                   *)
(*                                                                         *)
(* FixParts is the fix in clients/instance-registry.ts. deregisterInstance *)
(* advances a process-wide registration generation whenever any gate is   *)
(* on; each writer captures it when it is called:                          *)
(*  - "generation": a registration whose generation moved drops itself     *)
(*    before it sets the intent, and again under the lock before it        *)
(*    writes. The heartbeat's repair calls registerInstance after its own  *)
(*    lock, so it captures there;                                          *)
(*  - "child": recordLspChild synthesizes no entry once its generation     *)
(*    moved;                                                               *)
(*  - "rootIntent": deregisterInstanceRoot re-arms the intent only while   *)
(*    its generation holds;                                                *)
(*  - "retry": a sync removal that cannot take the lock is queued on the   *)
(*    tail. It runs after the op holding the lock and waits for the lock   *)
(*    instead of dropping (deregisterInstanceAfterHolder).                 *)
(*                                                                         *)
(* RootRemoval is how `deregisterInstanceRoot` takes the lock (an op on    *)
(* the tail, so never a bypass):                                           *)
(*  - "off": the secondary's own root is not modelled (the original model);*)
(*  - "sync": a sync attempt that gives up when the lock is busy and does  *)
(*    not retry: the code before #3657 (#3587 leaked the root);            *)
(*  - "syncQueued": the sync attempt, then the lease-waiting async lock in *)
(*    place on the tail slot (#3657);                                      *)
(*  - "syncAlways": mutant of #3657, the fallback runs after a successful  *)
(*    sync removal too (its `R1i` "always queue" mutation);                *)
(*  - "asyncBounded": mutant, one async lock with the ordinary bounded     *)
(*    wait, dropped on timeout (#3703 without LOCK_WAIT_THROUGH_LEASE_MS); *)
(*  - "queued": no sync attempt, one lease-waiting lock (#3703, merged).   *)
(*                                                                         *)
(* Teardown is the test worker's exit (#3703, tests/support/vitest-setup): *)
(*  - "off": not modelled;                                                 *)
(*  - "kill": the fork is killed with no join (before #3703, #3617);       *)
(*  - "join": the exit waits for the tail to drain, unbounded (#3703       *)
(*    round 1, review F3);                                                 *)
(*  - "bounded": the same join, abandoned after a real-time bound          *)
(*    (6.5 s = one lease + 1 s). The bound fires only while the process    *)
(*    does not hold the lock: a hold lasts milliseconds against the bound. *)
(* PeerStuck lets the other process hold the lock and never release: a     *)
(* holder the lease cannot clear (a filesystem error, or a stream of       *)
(* writers that keeps winning the lock, README).                           *)
(* SharedSec adds three holders of one more secondary root "T" (#3849),  *)
(* each a declined secondary activation with its own holder id: holders 1 *)
(* and 2 queue `registerInstanceRoot(T, h)` and later their shutdown's    *)
(* `deregisterInstanceRoot(T, h)`; holder 3 is the reload-gap subagent    *)
(* that never registered T and only shuts down. Holders are not tied to a *)
(* primary session, so one can outlive the primary's reload (whole-entry  *)
(* removal, then a new registration). `Evict` is the 32-root cap evicting *)
(* T inside some other root's registering write. `rec[h]` is holder h's   *)
(* durable record listing T (projectRootHolders). The fix's parts:        *)
(*  - "holderSet": a removal ends only its holder's own record, and drops  *)
(*    T only when that record listed T (otherwise it writes nothing);      *)
(*  - "holderOthers": ... and only when no other record lists T;           *)
(*  - "holderEvict": a cap eviction ends every record of the evicted root  *)
(*    in the same write.                                                   *)
(* Without "holderSet" (the code before #3849) a removal drops T from the *)
(* set; `rec` is then the ghost of each landed, not yet ended hold.        *)
(* The SharedSec configs leave out the heartbeat, the LSP spawn and the    *)
(* session-tied secondary (T1, T2): none of them writes "T" or a holder    *)
(* record, and the other configs cover their interleavings.               *)
(***************************************************************************)
EXTENDS Naturals, Sequences

CONSTANTS
    Contention,        \* another pi process may hold the registry lock
    HbRepair,          \* the #3447 heartbeat re-registration exists
    ClearIntent,       \* deregisterInstance clears the intent (#3447 guard)
    FixParts,          \* subset of {"generation","child","rootIntent","retry",
                       \*            "holderSet","holderOthers","holderEvict"}
    RootRemoval,       \* "off"|"sync"|"syncQueued"|"syncAlways"|"asyncBounded"|"queued"
    Teardown,          \* "off"|"kill"|"join"|"bounded"
    PeerStuck,         \* the other process may hold the lock and never release
    Reaper,            \* the reaper may prune dead pids, off the tail, in this process
    SharedSec          \* holders 1..3 of the shared secondary root "T" (#3849)

Root == [s \in 1..2 |-> IF s = 1 THEN "A" ELSE "B"]
Sec == [s \in 1..2 |-> IF s = 1 THEN "T1" ELSE "T2"]
Roots == {"A", "B", "T1", "T2", "T"}
\* The shared secondary root and its holders (#3849); holder 3 never registers.
Holders == 1..3
NoRec == [h \in Holders |-> FALSE]
None == "none"

VARIABLES
    sess,       \* current session index (0 = none started yet)
    live,       \* the current session is between start and shutdown
    entry,      \* roots in this pid's registry entry ({} = no entry)
    intent,     \* registrationIntent().root
    tail,       \* queued registry mutations of this process
    tpc,        \* head op: "idle" (not started) | "acq" | "held"
    lock,       \* registry lock holder: none | tail | hb | other
    hbPc,       \* per session heartbeat pc
    hbMissing,  \* per session: the heartbeat found no entry
    spawned,    \* per session: its LSP spawn was recorded (queued)
    secDone,    \* per session: its secondary's shutdown was queued
    gen,        \* registration generation, advanced by deregisterInstance
    secReg,     \* per session: its secondary's registerInstanceRoot was queued
    rmLanded,   \* per session: times its root removal ran under a lock
    stuck,      \* the other process holds the lock and never releases
    td,         \* teardown pc: "run" | "join" | "done"
    rpPc,       \* the reaper's own prune: "idle" | "acq" | "held" | "done"
    hs,         \* per holder of "T": "none" | "started" | "stopped"
    rec         \* per holder of "T": its durable record lists "T" (#3849)

\* The variables the original model had no part in: every pre-existing
\* action leaves them alone, except that a whole-entry removal ends every
\* holder record with the entry (aux0 leaves `rec` out for those).
aux0 == <<secReg, rmLanded, stuck, td, rpPc, hs>>
aux == <<aux0, rec>>

vars == <<sess, live, entry, intent, tail, tpc, lock, hbPc, hbMissing,
          spawned, secDone, gen, secReg, rmLanded, stuck, td, rpPc, hs, rec>>

GenGuard == "generation" \in FixParts
ChildGate == "child" \in FixParts
RootGate == "rootIntent" \in FixParts
Retry == "retry" \in FixParts
GenOn == GenGuard \/ ChildGate \/ RootGate
HolderSet == "holderSet" \in FixParts
HolderOthers == "holderOthers" \in FixParts
HolderEvict == "holderEvict" \in FixParts

SecOn == RootRemoval # "off"
SyncRoot == RootRemoval \in {"sync", "syncQueued", "syncAlways"}
\* The root removal waits through the lease instead of dropping.
RootWaits == RootRemoval \in {"syncQueued", "syncAlways", "queued"}

Op(k, r, g) == [kind |-> k, root |-> r, gen |-> g]
RegOp(r, g) == Op("reg", r, g)
DeregOp     == Op("dereg", None, 0)
\* deregisterInstanceRoot: `root` is the primary it re-arms the intent to,
\* `sec` the secondary's own root it removes, `s` the session it belongs to.
RootOp(s, g) == [kind |-> "root", root |-> Root[s], gen |-> g, sec |-> Sec[s], s |-> s]
\* registerInstanceRoot("T", h) ("hadd") and deregisterInstanceRoot("T", h)
\* ("hrm") of holder h (#3849).
HolderOp(k, h, g) == [kind |-> k, root |-> "T", gen |-> g, h |-> h]

TypeOK ==
    /\ sess \in 0..2
    /\ live \in BOOLEAN
    /\ entry \subseteq Roots
    /\ intent \in Roots \cup {None}
    /\ tpc \in {"idle", "acq", "held"}
    /\ lock \in {"none", "tail", "hb", "other", "reaper"}
    /\ hbPc \in [1..2 -> {"idle", "acq", "held", "post", "done"}]
    /\ hbMissing \in [1..2 -> BOOLEAN]
    /\ spawned \in [1..2 -> BOOLEAN]
    /\ secDone \in [1..2 -> BOOLEAN]
    /\ gen \in 0..2
    /\ secReg \in [1..2 -> BOOLEAN]
    /\ rmLanded \in [1..2 -> 0..2]
    /\ stuck \in BOOLEAN
    /\ td \in {"run", "join", "done"}
    /\ rpPc \in {"idle", "acq", "held", "done"}
    /\ hs \in [Holders -> {"none", "started", "stopped"}]
    /\ rec \in [Holders -> BOOLEAN]

Init ==
    /\ sess = 0
    /\ live = FALSE
    /\ entry = {}
    /\ intent = None
    /\ tail = <<>>
    /\ tpc = "idle"
    /\ lock = "none"
    /\ hbPc = [s \in 1..2 |-> "idle"]
    /\ hbMissing = [s \in 1..2 |-> FALSE]
    /\ spawned = [s \in 1..2 |-> FALSE]
    /\ secDone = [s \in 1..2 |-> FALSE]
    /\ gen = 0
    /\ secReg = [s \in 1..2 |-> FALSE]
    /\ rmLanded = [s \in 1..2 |-> 0]
    /\ stuck = FALSE
    /\ td = "run"
    /\ rpPc = "idle"
    /\ hs = [h \in Holders |-> "none"]
    /\ rec = NoRec

(* ---------------- host ---------------- *)

Start ==
    /\ ~live /\ sess < 2
    /\ sess' = sess + 1
    /\ live' = TRUE
    /\ tail' = Append(tail, RegOp(Root[sess + 1], gen))
    /\ UNCHANGED <<entry, intent, tpc, lock, hbPc, hbMissing, spawned, secDone, gen, aux>>

\* deregisterInstance(): sync, bypasses the tail.
Shutdown ==
    /\ live
    /\ live' = FALSE
    /\ intent' = IF ClearIntent THEN None ELSE intent
    /\ gen' = IF GenOn THEN gen + 1 ELSE gen
    /\ \/ /\ lock = "none"                       \* lock free: removed
          /\ entry' = {} /\ rec' = NoRec
          /\ UNCHANGED tail
       \/ /\ lock = "other" /\ ~stuck            \* the other process released
          /\ entry' = {} /\ rec' = NoRec         \* inside the 500 ms spin
          /\ UNCHANGED tail
       \/ /\ lock # "none"                       \* removal skipped: own hold
                                                 \* (no wait) or timeout
          /\ UNCHANGED <<entry, rec>>
          /\ tail' = IF Retry THEN Append(tail, DeregOp) ELSE tail
    /\ UNCHANGED <<sess, tpc, lock, hbPc, hbMissing, spawned, secDone, aux0>>

\* `void recordLspChild({..., sessionIdentity: {projectRoot: cwd}})`.
LspSpawn(s) ==
    /\ ~SharedSec /\ live /\ sess = s /\ ~spawned[s]
    /\ spawned' = [spawned EXCEPT ![s] = TRUE]
    /\ tail' = Append(tail, Op("child", Root[s], gen))
    /\ UNCHANGED <<sess, live, entry, intent, tpc, lock, hbPc, hbMissing, secDone, gen, aux>>

\* A declined secondary's start: `void registerInstanceRoot(cwd)`.
SecondaryStart(s) ==
    /\ SecOn /\ ~SharedSec /\ live /\ sess = s /\ ~secReg[s]
    /\ secReg' = [secReg EXCEPT ![s] = TRUE]
    /\ tail' = Append(tail, Op("radd", Sec[s], gen))
    /\ UNCHANGED <<sess, live, entry, intent, tpc, lock, hbPc, hbMissing,
                   spawned, secDone, gen, rmLanded, stuck, td, rpPc, hs, rec>>

\* A holder of "T" starts (#3849): `void registerInstanceRoot(T, h)`, any
\* time after the first primary start, including the reload gap. Holder 3
\* is the reload-gap subagent that never registers.
HolderStart(h) ==
    /\ SharedSec /\ h # 3 /\ sess >= 1 /\ hs[h] = "none"
    /\ hs' = [hs EXCEPT ![h] = "started"]
    /\ tail' = Append(tail, HolderOp("hadd", h, gen))
    /\ UNCHANGED <<sess, live, entry, intent, tpc, lock, hbPc, hbMissing,
                   spawned, secDone, gen, secReg, rmLanded, stuck, td, rpPc, rec>>

\* A holder's shutdown: `void deregisterInstanceRoot(T, h)`, queued behind
\* its own add. Holder 3 shuts down without ever having started an add.
HolderStop(h) ==
    /\ SharedSec /\ sess >= 1
    /\ \/ hs[h] = "started"
       \/ (h = 3 /\ hs[h] = "none")
    /\ hs' = [hs EXCEPT ![h] = "stopped"]
    /\ tail' = Append(tail, HolderOp("hrm", h, gen))
    /\ UNCHANGED <<sess, live, entry, intent, tpc, lock, hbPc, hbMissing,
                   spawned, secDone, gen, secReg, rmLanded, stuck, td, rpPc, rec>>

\* The 32-root cap evicts "T" inside some other root's registering write
\* (#3849): "holderEvict" ends every record of T in that same write.
Evict ==
    /\ SharedSec /\ "T" \in entry
    /\ entry' = entry \ {"T"}
    /\ rec' = IF HolderSet /\ ~HolderEvict THEN rec ELSE NoRec
    /\ UNCHANGED <<sess, live, intent, tail, tpc, lock, hbPc, hbMissing,
                   spawned, secDone, gen, secReg, rmLanded, stuck, td, rpPc, hs>>

\* A declined secondary's `deregisterInstanceRoot(tempRoot)`. Its own start
\* was queued first (the shutdown follows the start), so the removal lands
\* behind the add.
SecondaryShutdown(s) ==
    /\ live /\ sess = s /\ ~secDone[s]
    /\ ~SecOn \/ secReg[s]
    /\ secDone' = [secDone EXCEPT ![s] = TRUE]
    /\ tail' = Append(tail, RootOp(s, gen))
    /\ UNCHANGED <<sess, live, entry, intent, tpc, lock, hbPc, hbMissing, spawned, gen, aux>>

(* ---------------- another process ---------------- *)

OtherAcquire ==
    /\ Contention /\ lock = "none"
    /\ lock' = "other"
    /\ stuck' \in (IF PeerStuck THEN BOOLEAN ELSE {FALSE})
    /\ UNCHANGED <<sess, live, entry, intent, tail, tpc, hbPc, hbMissing, spawned, secDone, gen,
                   secReg, rmLanded, td, rpPc, hs, rec>>

OtherRelease ==
    /\ lock = "other" /\ ~stuck
    /\ lock' = "none"
    /\ UNCHANGED <<sess, live, entry, intent, tail, tpc, hbPc, hbMissing, spawned, secDone, gen, aux>>

(* ---------------- the mutation tail ---------------- *)

Op1 == tail[1]

\* registerInstanceNow's first statement: rememberRegistrationRoot(root).
\* Fix "generation": a registration whose generation moved does nothing.
\* A root removal that takes the sync lock first (RootRemoval "sync*") begins
\* in RootSyncAttempt instead.
TailBegin ==
    /\ tail # <<>> /\ tpc = "idle"
    /\ ~(SyncRoot /\ Op1.kind = "root")
    /\ IF Op1.kind = "reg"
         THEN IF GenGuard /\ Op1.gen # gen
                THEN /\ tail' = Tail(tail) /\ UNCHANGED <<intent, tpc>>
                ELSE /\ intent' = Op1.root /\ tpc' = "acq" /\ UNCHANGED tail
         ELSE /\ tpc' = "acq" /\ UNCHANGED <<intent, tail>>
    /\ UNCHANGED <<sess, live, entry, lock, hbPc, hbMissing, spawned, secDone, gen, aux>>

\* What a root removal does to the intent: re-arm it to the root the entry
\* still holds, unless the fix's generation gate says the session ended.
RootApplies ==
    /\ Op1.kind = "root" /\ Op1.root \in entry
    /\ ~(RootGate /\ Op1.gen # gen)

RootLanded ==
    IF SecOn THEN [rmLanded EXCEPT ![Op1.s] = @ + 1] ELSE rmLanded

\* The sync attempt `deregisterInstanceRootNow` made before #3657 (and
\* `withInstanceRegistryLockSync`'s 500 ms spin, which now returns at once
\* when an own async hold is in flight): the lock is taken
\* atomically when it is free, or when the other process releases inside the
\* spin; it is busy for the whole spin when this process's own heartbeat
\* holds it (the holder cannot release while Atomics.wait blocks the loop).
\*  - "sync": a busy lock drops the removal (#3587: the root leaks);
\*  - "syncQueued": a busy lock falls back to the async lease-waiting lock,
\*    in place on the tail slot (#3657);
\*  - "syncAlways": the fallback runs after a successful removal as well.
RootSyncAttempt ==
    /\ SyncRoot /\ tail # <<>> /\ tpc = "idle" /\ Op1.kind = "root"
    /\ \/ /\ \/ lock = "none" \/ (lock = "other" /\ ~stuck)
          /\ entry' = entry \ {Op1.sec}
          /\ intent' = IF RootApplies THEN Op1.root ELSE intent
          /\ rmLanded' = RootLanded
          /\ IF RootRemoval = "syncAlways"
               THEN /\ tpc' = "acq" /\ UNCHANGED tail
               ELSE /\ tail' = Tail(tail) /\ UNCHANGED tpc
       \/ /\ lock # "none" /\ ~(lock = "other" /\ ~stuck)
          /\ UNCHANGED <<entry, intent, rmLanded>>
          /\ IF RootRemoval = "sync"
               THEN /\ tail' = Tail(tail) /\ UNCHANGED tpc
               ELSE /\ tpc' = "acq" /\ UNCHANGED tail
    /\ UNCHANGED <<sess, live, lock, hbPc, hbMissing, spawned, secDone, gen,
                   secReg, stuck, td, rpPc, hs, rec>>

TailAcquire ==
    /\ tpc = "acq" /\ lock = "none"
    /\ lock' = "tail" /\ tpc' = "held"
    /\ UNCHANGED <<sess, live, entry, intent, tail, hbPc, hbMissing, spawned, secDone, gen, aux>>

\* The lock's bounded wait ran out: the op is dropped. The fix's queued
\* removal waits through the lease instead: it stays at the head and retries.
\* So does a root removal once #3657 made it lease-waiting (RootWaits).
TailTimeout ==
    /\ tpc = "acq" /\ lock \notin {"none", "tail"}
    /\ Op1.kind # "dereg"
    /\ ~(Op1.kind \in {"root", "hrm"} /\ RootWaits)
    /\ tail' = Tail(tail) /\ tpc' = "idle"
    /\ UNCHANGED <<sess, live, entry, intent, lock, hbPc, hbMissing, spawned, secDone, gen, aux>>

Stale == Op1.gen # gen

\* The write and the release.
\*  - "reg" MERGES the root into the entry (mergeInstanceRoots); fix
\*    "generation" re-checks under the lock.
\*  - "child" adds a child to an existing entry (roots unchanged), or
\*    synthesizes one with the session's root; fix "child" skips that.
\*  - "radd" adds the secondary's root to an existing entry, never creating
\*    one (registerInstanceRootNow).
\*  - "root" drops the secondary's root (RootRemoval # "off") and re-arms the
\*    intent to the root the entry still holds; fix "rootIntent" skips the
\*    intent write once stale.
\*  - "hadd" adds "T" and holder h's record to an existing entry, never
\*    creating one; "hrm" ends holder h's record and drops "T" per
\*    HolderDrops. "dereg" ends every record with the entry.
\* Whether a holder's removal drops "T" (#3849). Before the fix the entry is
\* a set, so it always does.
HolderDrops ==
    IF ~HolderSet THEN TRUE
    ELSE /\ rec[Op1.h]
         /\ (~HolderOthers \/ ~\E k \in Holders \ {Op1.h} : rec[k])

TailWrite ==
    /\ tpc = "held"
    /\ entry' = CASE Op1.kind = "dereg" -> {}
                  [] Op1.kind = "reg" ->
                        IF GenGuard /\ Stale THEN entry ELSE entry \cup {Op1.root}
                  [] Op1.kind = "child" ->
                        IF entry # {} \/ (ChildGate /\ Stale) THEN entry ELSE {Op1.root}
                  [] Op1.kind \in {"radd", "hadd"} ->
                        IF entry # {} THEN entry \cup {Op1.root} ELSE entry
                  [] Op1.kind = "root" /\ SecOn -> entry \ {Op1.sec}
                  [] Op1.kind = "hrm" ->
                        IF HolderDrops THEN entry \ {"T"} ELSE entry
                  [] OTHER -> entry
    /\ rec' = CASE Op1.kind = "dereg" -> NoRec
                [] Op1.kind = "hadd" /\ entry # {} -> [rec EXCEPT ![Op1.h] = TRUE]
                [] Op1.kind = "hrm" -> [rec EXCEPT ![Op1.h] = FALSE]
                [] OTHER -> rec
    /\ intent' = IF RootApplies THEN Op1.root ELSE intent
    /\ rmLanded' = IF Op1.kind = "root" THEN RootLanded ELSE rmLanded
    /\ lock' = "none" /\ tpc' = "idle" /\ tail' = Tail(tail)
    /\ UNCHANGED <<sess, live, hbPc, hbMissing, spawned, secDone, gen, secReg, stuck, td, rpPc, hs>>

(* ---------------- heartbeat ---------------- *)

HbStart(s) ==
    /\ ~SharedSec /\ live /\ sess = s /\ hbPc[s] = "idle"
    /\ hbPc' = [hbPc EXCEPT ![s] = "acq"]
    /\ UNCHANGED <<sess, live, entry, intent, tail, tpc, lock, hbMissing, spawned, secDone, gen, aux>>

HbAcquire(s) ==
    /\ hbPc[s] = "acq" /\ lock = "none"
    /\ lock' = "hb"
    /\ hbPc' = [hbPc EXCEPT ![s] = "held"]
    /\ UNCHANGED <<sess, live, entry, intent, tail, tpc, hbMissing, spawned, secDone, gen, aux>>

HbTimeout(s) ==
    /\ hbPc[s] = "acq" /\ lock \notin {"none", "hb"}
    /\ hbPc' = [hbPc EXCEPT ![s] = "done"]
    /\ UNCHANGED <<sess, live, entry, intent, tail, tpc, lock, hbMissing, spawned, secDone, gen, aux>>

\* Refreshes heartbeatAt/rss only; roots are untouched. Notes a missing entry.
HbWrite(s) ==
    /\ hbPc[s] = "held"
    /\ hbMissing' = [hbMissing EXCEPT ![s] = (entry = {})]
    /\ lock' = "none"
    /\ hbPc' = [hbPc EXCEPT ![s] = "post"]
    /\ UNCHANGED <<sess, live, entry, intent, tail, tpc, spawned, secDone, gen, aux>>

\* After the lock: `missing && intent.root !== undefined` ->
\* `void registerInstance(intent.root)`, which captures the generation now.
HbPost(s) ==
    /\ hbPc[s] = "post"
    /\ tail' = IF HbRepair /\ hbMissing[s] /\ intent # None
               THEN Append(tail, RegOp(intent, gen))
               ELSE tail
    /\ hbPc' = [hbPc EXCEPT ![s] = "done"]
    /\ UNCHANGED <<sess, live, entry, intent, tpc, lock, hbMissing, spawned, secDone, gen, aux>>

(* ---------------- the reaper (#3617 residue) ---------------- *)

\* `pruneDeadInstances` (clients/instance-registry.ts) takes the registry
\* lock directly, OFF the tail, to drop dead pids' entries (this process's own
\* entry is not among them). The teardown's join waits on the tail only, so it
\* does not wait for this hold.
ReaperStart ==
    /\ Reaper /\ rpPc = "idle"
    /\ rpPc' = "acq"
    /\ UNCHANGED <<sess, live, entry, intent, tail, tpc, lock, hbPc, hbMissing,
                   spawned, secDone, gen, secReg, rmLanded, stuck, td, hs, rec>>

ReaperAcquire ==
    /\ rpPc = "acq" /\ lock = "none"
    /\ lock' = "reaper" /\ rpPc' = "held"
    /\ UNCHANGED <<sess, live, entry, intent, tail, tpc, hbPc, hbMissing,
                   spawned, secDone, gen, secReg, rmLanded, stuck, td, hs, rec>>

ReaperWrite ==
    /\ rpPc = "held"
    /\ lock' = "none" /\ rpPc' = "done"
    /\ UNCHANGED <<sess, live, entry, intent, tail, tpc, hbPc, hbMissing,
                   spawned, secDone, gen, secReg, rmLanded, stuck, td, hs, rec>>

(* ---------------- the test worker's teardown (#3703) ---------------- *)

\* Every registry mutation of this process has settled: the tail is empty (an
\* op leaves it when it lands, so none is in flight), and no heartbeat is
\* between its lock and its repair.
\* (The code queues the heartbeat on the tail, so the join covers it; the
\* model's off-tail heartbeat is the over-approximation.)
Drained ==
    /\ tail = <<>>
    /\ \A s \in 1..2 : hbPc[s] \in {"idle", "done"}

\* The last session ended; the worker tears down. "kill" exits at once, with
\* ops queued or in flight.
TdBegin ==
    /\ Teardown # "off" /\ td = "run" /\ ~live /\ sess = 2
    /\ td' = IF Teardown = "kill" THEN "done" ELSE "join"
    /\ UNCHANGED <<sess, live, entry, intent, tail, tpc, lock, hbPc, hbMissing,
                   spawned, secDone, gen, secReg, rmLanded, stuck, rpPc, hs, rec>>

\* `_settleRegistryMutationsForTests` resolved: the join is over.
TdJoined ==
    /\ td = "join" /\ Drained
    /\ td' = "done"
    /\ UNCHANGED <<sess, live, entry, intent, tail, tpc, lock, hbPc, hbMissing,
                   spawned, secDone, gen, secReg, rmLanded, stuck, rpPc, hs, rec>>

\* The real-time bound on the join ran out (the `[registry-settle]` line).
TdGiveUp ==
    /\ Teardown = "bounded" /\ td = "join" /\ ~Drained
    /\ lock \notin {"tail", "hb", "reaper"}
    /\ td' = "done"
    /\ UNCHANGED <<sess, live, entry, intent, tail, tpc, lock, hbPc, hbMissing,
                   spawned, secDone, gen, secReg, rmLanded, stuck, rpPc, hs, rec>>

Step ==
    \/ Start \/ Shutdown
    \/ OtherAcquire \/ OtherRelease
    \/ TailBegin \/ RootSyncAttempt \/ TailAcquire \/ TailTimeout \/ TailWrite
    \/ TdBegin \/ TdJoined \/ TdGiveUp
    \/ ReaperStart \/ ReaperAcquire \/ ReaperWrite
    \/ Evict
    \/ \E h \in Holders : HolderStart(h) \/ HolderStop(h)
    \/ \E s \in 1..2 : \/ HbStart(s) \/ HbAcquire(s) \/ HbTimeout(s)
                       \/ HbWrite(s) \/ HbPost(s)
                       \/ LspSpawn(s) \/ SecondaryStart(s)
                       \/ SecondaryShutdown(s)

\* The process has exited: nothing runs after it.
Next == (td # "done" /\ Step) \/ (td = "done" /\ UNCHANGED vars)

Spec == Init /\ [][Next]_vars

(* ---------------- invariants ---------------- *)

DeregQueued == \E i \in 1..Len(tail) : tail[i].kind = "dereg"

\* A live secondary holds its root until it asks to drop it; once it has, the
\* removal is queued or in flight (an op stays at the head until it lands).
\* "T" is held while any holder's record lists it (#3849).
SecHeld(r) ==
    \/ \E s \in 1..2 : r = Sec[s] /\ live /\ sess = s /\ ~secDone[s]
    \/ r = "T" /\ \E h \in Holders : rec[h]
RootOpPending(r) == \E i \in 1..Len(tail) : tail[i].kind = "root" /\ tail[i].sec = r

\* A root the process no longer serves is never in its entry: an ended
\* session never re-registers, and a secondary whose shutdown ran does not
\* leave its root behind (#3587) unless its removal is still pending. The
\* only other exception is the fix's own queued deregistration, which has not
\* landed yet.
NoGhostRoot ==
    \A r \in entry :
        \/ (live /\ r = Root[sess])
        \/ DeregQueued
        \/ SecHeld(r)
        \/ RootOpPending(r)

\* A live session is never dropped for good: its root is in the entry, or a
\* registration for it is still queued, or the heartbeat can still repair it
\* from the intent.
RegQueuedFor(r) ==
    \E i \in 1..Len(tail) :
        tail[i].kind = "reg" /\ tail[i].root = r /\ (~GenGuard \/ tail[i].gen = gen)
LiveRepairable ==
    live => \/ Root[sess] \in entry
            \/ RegQueuedFor(Root[sess])
            \/ (HbRepair /\ intent = Root[sess])

\* The worker never exits holding the registry lock: a killed holder leaves a
\* lock generation of a dead pid behind (#3617). The reaper's own prune is
\* the hold the tail join does not see.
NoExitWhileHeld == td = "done" => lock \notin {"tail", "hb", "reaper"}

\* A secondary's root removal runs under a lock at most once: the observable
\* `instance-registry-deregister-landed` record is one per removal.
RootRemovedOnce == \A s \in 1..2 : rmLanded[s] <= 1

\* The teardown always has a step to take: it finishes, or its bound fires.
\* A join with no bound on a lock that never frees has none.
TeardownProgress == (Teardown # "off" /\ td # "done") => ENABLED Step

\* The ownership rule (#3849): a root stays in the entry while any holder's
\* record lists it. A record ends only by its holder's own removal, a
\* whole-entry removal, or the cap evicting its root; so no other holder's
\* removal, and no removal by a holder whose hold already ended (a reload,
\* an eviction, an add that found no entry, or one never made), frees it.
SharedRootHeld == \A h \in Holders : rec[h] => "T" \in entry
=============================================================================
