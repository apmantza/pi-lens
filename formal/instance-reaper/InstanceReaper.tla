--------------------------- MODULE InstanceReaper ---------------------------
(***************************************************************************)
(* The code in pi-lens that decides to kill processes it judges orphaned:  *)
(*                                                                         *)
(*  - the registry-driven sweep `sweepOrphans` (instance-reaper.ts         *)
(*    ~1394-1508): read instances.json, query the command lines of every   *)
(*    recorded child pid (`queryCommandLines`, ~410), decide               *)
(*    (`decideOrphanReaping`, ~255), kill each chosen pid in turn          *)
(*    (`killPidTree` + a verify poll, ~520), then prune the dead and       *)
(*    stale entries BY PID (`pruneDeadInstances`, instance-registry.ts     *)
(*    ~1100). Fire-and-forget at every session_start (index.ts ~2372), no  *)
(*    lock, so several run concurrently;                                   *)
(*  - the registry-independent backstop `sweepUntrackedOrphans` (~915):    *)
(*    enumerate processes whose command line names a managed binary, keep *)
(*    those untracked by any entry, with a dead-looking parent pid and     *)
(*    older than the spawn grace (`partitionBackstopCandidates`, ~740),    *)
(*    kill each in turn. Serialized by the quarantine/generation lock;     *)
(*  - the MCP host's `pilens_health` footprint read (mcp/server.ts ~1612 -> *)
(*    `getResourceFootprint`, instance-registry.ts ~1072), which prunes    *)
(*    dead-pid entries WITHOUT killing their children.                     *)
(*                                                                         *)
(* Writers of the registry: `registerInstance` (session_start and the      *)
(* heartbeat's repair; it keys on pid and carries the existing entry's     *)
(* lspChildren, ~356-406), `recordLspChild` (fire-and-forget at LSP spawn,  *)
(* lsp/client.ts ~5684; synthesizes the host entry when missing, ~650),    *)
(* `removeLspChild` on a child's exit, `deregisterInstance` on clean       *)
(* shutdown (by pid, ~781).                                                *)
(*                                                                         *)
(* The OS: pids are reused; a process's identity is (pid, birth). On POSIX *)
(* an orphan is reparented (ppid becomes init or a subreaper, which is     *)
(* alive); on Windows its ppid keeps naming the dead parent's pid.         *)
(* Command-line identity is a set of tokens: an LSP child's command line   *)
(* carries "node" and "ts" (node .../typescript-language-server), a pi     *)
(* host's carries "node".                                                  *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS
    Pids,           \* OS pid slots (0 stands for init/subreaper, always alive)
    Insts,          \* pi-lens instances (pi sessions or an MCP host)
    Mcp,            \* instances that never register or heartbeat (MCP host)
    Crashable,      \* instances that may die without shutdown
    NoKids,         \* instances that spawn no LSP child (others spawn one)
    MaxBirth,       \* bound on process creations
    Reapers,        \* concurrent registry-driven sweeps
    Backstops,      \* concurrent backstop sweeps
    Posix,          \* TRUE: orphans reparent to init
    PidReuse,       \* a freed pid may be handed to a new process
    OtherProcs,     \* unrelated processes may take free pids
    RecCmd,         \* the command token recordLspChild records ("ts" | "node")
    LateRecord,     \* a host may die before its fire-and-forget record lands
    FootprintPrune, \* the MCP health read prunes dead-pid entries
    ScanFail,       \* the identity query may fail (empty map)
    StalePrune,     \* heartbeat staleness removes the entry (pid alive)
    Guards,         \* existing guards, subset of {"parentDead","identity","ppid","tracked","lock"}
    FixParts        \* candidate fix, subset of {"birth","recheck","tag","retain"}

Birth   == "birth"   \in FixParts
Recheck == "recheck" \in FixParts
Tag     == "tag"     \in FixParts
Retain  == "retain"  \in FixParts

Kinds == {"free", "host", "lsp", "other"}
Toks  == {"node", "ts"}
NoInst == "-"
Free == [k |-> "free", i |-> NoInst, b |-> 0, pp |-> 0, t |-> {}, old |-> FALSE]

VARIABLES
    procs,   \* [Pids -> process] what each pid names now
    nb,      \* next birth serial
    used,    \* pids ever allocated (for PidReuse = FALSE)
    st,      \* [Insts -> {"unborn","live","dead"}]
    hp,      \* [Insts -> host pid]
    hb,      \* [Insts -> host birth]
    kidsN,   \* [Insts -> spawns so far]
    pend,    \* [Insts -> kid records spawned but not yet recorded]
    reg,     \* instances.json: set of [p, hb, kids, stale]
    rpc,     \* [Reapers -> "idle" | "kill"]
    rkill,   \* [Reapers -> kid records chosen for a kill]
    rprune,  \* [Reapers -> [p, hb] entries chosen for removal]
    bpc,     \* [Backstops -> "idle" | "kill"]
    bkill,   \* [Backstops -> [p, b] chosen for a kill]
    wrong    \* a kill hit a process that is not an orphan

vars == <<procs, nb, used, st, hp, hb, kidsN, pend, reg, rpc, rkill, rprune, bpc, bkill, wrong>>

-----------------------------------------------------------------------------
Alive(q) == q = 0 \/ procs[q].k # "free"
Orphan(p) == procs[p].k = "lsp" /\ st[procs[p].i] = "dead"
Kid(p, b) == [p |-> p, b |-> b, c |-> RecCmd]

\* A pid the allocator may hand out now.
Allocatable(p) == procs[p].k = "free" /\ (PidReuse \/ p \notin used)

\* The entry that belongs to instance i: code keys on pid (registerInstance,
\* recordLspChild, deregisterInstance); the fix keys on (pid, birth).
Mine(e, i) == e.p = hp[i] /\ (Birth => e.hb = hb[i])

\* buildIdentityMatcher: the recorded command's basename appears in the
\* pid's command line (the marker arm only strengthens a match; markers are
\* per host pid and root, see sgconfig.ts ~288). The fix also compares the
\* OS start time recorded at spawn.
Match(k) ==
    \/ "identity" \notin Guards
    \/ /\ k.c \in procs[k.p].t
       /\ Birth => procs[k.p].b = k.b

\* isInstanceKillEligible: !isPidAlive(entry.pid). The fix also treats a pid
\* whose start time differs from the entry's host birth as dead.
HostDead(e) ==
    \/ "parentDead" \notin Guards
    \/ ~Alive(e.p)
    \/ (Birth /\ procs[e.p].b # e.hb)

\* partitionBackstopCandidates' trackedPids: by pid in the code; the fix
\* compares (pid, start time), so a dead record cannot shield a new process.
Tracked(p) ==
    \E e \in reg : \E k \in e.kids : k.p = p /\ (Birth => k.b = procs[p].b)

\* The backstop's "dead parent": code reads the OS ppid; the fix reads the
\* owner incarnation the process carries (tag), never the ppid.
PPDead(p) ==
    IF Tag
    THEN procs[p].k = "lsp" /\ st[procs[p].i] = "dead"
    ELSE \/ "ppid" \notin Guards
         \/ procs[p].pp # 0 /\ ~Alive(procs[p].pp)

BackstopCandidate(p) ==
    /\ procs[p].k # "free"
    /\ "ts" \in procs[p].t                         \* managed-binary name
    /\ ("tracked" \in Guards => ~Tracked(p))
    /\ PPDead(p)
    /\ procs[p].old                                \* spawn grace

\* A kill of pid p: ESRCH on a free pid; otherwise it lands on whatever p
\* names now.
DoKill(p) ==
    IF procs[p].k = "free" THEN UNCHANGED <<procs, wrong>>
    ELSE /\ wrong' = (wrong \/ ~Orphan(p))
         /\ procs' = [procs EXCEPT ![p] = Free]

\* An entry removal that keeps any child still alive under its identity.
KidLive(k) == Alive(k.p) /\ procs[k.p].k # "free" /\ Match(k)
Shrink(e) == [e EXCEPT !.kids = {k \in e.kids : KidLive(k)}]
RetainPrune(S) ==
    {Shrink(e) : e \in {x \in reg : x \in S /\ Shrink(x).kids # {}}} \cup (reg \ S)

-----------------------------------------------------------------------------
TypeOK ==
    /\ \A p \in Pids : procs[p].k \in Kinds
    /\ st \in [Insts -> {"unborn", "live", "dead"}]
    /\ wrong \in BOOLEAN

Init ==
    /\ procs = [p \in Pids |-> Free]
    /\ nb = 1
    /\ used = {}
    /\ st = [i \in Insts |-> "unborn"]
    /\ hp = [i \in Insts |-> 0]
    /\ hb = [i \in Insts |-> 0]
    /\ kidsN = [i \in Insts |-> 0]
    /\ pend = [i \in Insts |-> {}]
    /\ reg = {}
    /\ rpc = [r \in Reapers |-> "idle"]
    /\ rkill = [r \in Reapers |-> {}]
    /\ rprune = [r \in Reapers |-> {}]
    /\ bpc = [b \in Backstops |-> "idle"]
    /\ bkill = [b \in Backstops |-> {}]
    /\ wrong = FALSE

Alloc(p, proc) ==
    /\ procs' = [procs EXCEPT ![p] = proc]
    /\ nb' = nb + 1
    /\ used' = used \cup {p}

\* ---- instances ----------------------------------------------------------
Start(i) ==
    /\ st[i] = "unborn" /\ nb <= MaxBirth
    /\ \E p \in Pids \ {0} :
        /\ Allocatable(p)
        /\ Alloc(p, [k |-> "host", i |-> i, b |-> nb, pp |-> 0, t |-> {"node"}, old |-> TRUE])
        /\ st' = [st EXCEPT ![i] = "live"]
        /\ hp' = [hp EXCEPT ![i] = p]
        /\ hb' = [hb EXCEPT ![i] = nb]
    /\ UNCHANGED <<kidsN, pend, reg, rpc, rkill, rprune, bpc, bkill, wrong>>

\* registerInstance / the heartbeat: refresh, or (re)create the entry,
\* carrying the lspChildren of whatever entry it keys onto.
Register(i) ==
    /\ st[i] = "live" /\ i \notin Mcp
    /\ LET ex == {e \in reg : Mine(e, i)}
       IN reg' = (reg \ ex) \cup
                 {[p |-> hp[i], hb |-> hb[i], kids |-> UNION {e.kids : e \in ex}, stale |-> FALSE]}
    /\ UNCHANGED <<procs, nb, used, st, hp, hb, kidsN, pend, rpc, rkill, rprune, bpc, bkill, wrong>>

\* spawnLSP: the child is born, its record is queued (fire-and-forget).
Spawn(i) ==
    /\ st[i] = "live" /\ i \notin NoKids /\ kidsN[i] < 1 /\ nb <= MaxBirth
    /\ \E p \in Pids \ {0} :
        /\ Allocatable(p)
        /\ Alloc(p, [k |-> "lsp", i |-> i, b |-> nb, pp |-> hp[i], t |-> {"node", "ts"}, old |-> FALSE])
        /\ pend' = [pend EXCEPT ![i] = @ \cup {Kid(p, nb)}]
    /\ kidsN' = [kidsN EXCEPT ![i] = @ + 1]
    /\ UNCHANGED <<st, hp, hb, reg, rpc, rkill, rprune, bpc, bkill, wrong>>

\* recordLspChildNow: add to this host's entry, or synthesize one.
Record(i) ==
    /\ st[i] = "live"
    /\ \E k \in pend[i] :
        /\ pend' = [pend EXCEPT ![i] = @ \ {k}]
        /\ LET ex == {e \in reg : Mine(e, i)}
           IN IF ex = {}
              THEN reg' = reg \cup {[p |-> hp[i], hb |-> hb[i], kids |-> {k}, stale |-> FALSE]}
              ELSE reg' = {IF e \in ex
                           THEN [e EXCEPT !.kids = {x \in e.kids : x.p # k.p} \cup {k}]
                           ELSE e : e \in reg}
    /\ UNCHANGED <<procs, nb, used, st, hp, hb, kidsN, rpc, rkill, rprune, bpc, bkill, wrong>>

\* An LSP child exits by itself. A live owner's removeLspChild drops the
\* record (atomic with the exit here: its own exit handler).
LspExit(p) ==
    /\ procs[p].k = "lsp"
    /\ procs' = [procs EXCEPT ![p] = Free]
    /\ LET i == procs[p].i IN
       /\ IF st[i] = "live"
          THEN reg' = {IF Mine(e, i) THEN [e EXCEPT !.kids = {x \in e.kids : x.p # p}] ELSE e : e \in reg}
          ELSE UNCHANGED reg
       /\ pend' = [pend EXCEPT ![i] = {x \in @ : x.p # p}]
    /\ UNCHANGED <<nb, used, st, hp, hb, kidsN, rpc, rkill, rprune, bpc, bkill, wrong>>

\* Crash: the host dies without shutdown; its LSP children live on.
Crash(i) ==
    /\ st[i] = "live" /\ i \in Crashable
    /\ (~LateRecord => pend[i] = {})
    /\ st' = [st EXCEPT ![i] = "dead"]
    /\ procs' = [p \in Pids |->
                   IF p = hp[i] THEN Free
                   ELSE IF procs[p].k = "lsp" /\ procs[p].i = i /\ Posix
                        THEN [procs[p] EXCEPT !.pp = 0]
                        ELSE procs[p]]
    /\ pend' = [pend EXCEPT ![i] = {}]
    /\ UNCHANGED <<nb, used, hp, hb, kidsN, reg, rpc, rkill, rprune, bpc, bkill, wrong>>

\* Clean shutdown: the LSP shutdown kills its own children through their
\* handles, and deregisterInstance removes the entry (by pid in the code).
Exit(i) ==
    /\ st[i] = "live" /\ pend[i] = {}
    /\ st' = [st EXCEPT ![i] = "dead"]
    /\ procs' = [p \in Pids |->
                   IF p = hp[i] \/ (procs[p].k = "lsp" /\ procs[p].i = i) THEN Free
                   ELSE procs[p]]
    /\ reg' = {e \in reg : ~Mine(e, i)}
    /\ UNCHANGED <<nb, used, hp, hb, kidsN, pend, rpc, rkill, rprune, bpc, bkill, wrong>>

\* ---- the environment ------------------------------------------------------
OtherStart ==
    /\ OtherProcs /\ nb <= MaxBirth
    /\ \E p \in Pids \ {0}, t \in {{"node"}, {"node", "ts"}} :
        /\ Allocatable(p)
        /\ Alloc(p, [k |-> "other", i |-> NoInst, b |-> nb, pp |-> 0, t |-> t, old |-> TRUE])
    /\ UNCHANGED <<st, hp, hb, kidsN, pend, reg, rpc, rkill, rprune, bpc, bkill, wrong>>

OtherExit(p) ==
    /\ procs[p].k = "other"
    /\ procs' = [procs EXCEPT ![p] = Free]
    /\ UNCHANGED <<nb, used, st, hp, hb, kidsN, pend, reg, rpc, rkill, rprune, bpc, bkill, wrong>>

Age(p) ==
    /\ procs[p].k # "free" /\ ~procs[p].old
    /\ procs' = [procs EXCEPT ![p].old = TRUE]
    /\ UNCHANGED <<nb, used, st, hp, hb, kidsN, pend, reg, rpc, rkill, rprune, bpc, bkill, wrong>>

\* No heartbeat for STALE_HEARTBEAT_MS (idle session, or an MCP host that
\* never heartbeats).
GoStale ==
    /\ StalePrune
    /\ \E e \in reg :
        /\ ~e.stale
        /\ reg' = (reg \ {e}) \cup {[e EXCEPT !.stale = TRUE]}
    /\ UNCHANGED <<procs, nb, used, st, hp, hb, kidsN, pend, rpc, rkill, rprune, bpc, bkill, wrong>>

\* getResourceFootprint: prune every dead-pid entry, no kills.
Footprint ==
    /\ FootprintPrune
    /\ LET dead == {e \in reg : ~Alive(e.p) \/ (Birth /\ procs[e.p].b # e.hb)}
       IN /\ dead # {}
          /\ reg' = IF Retain THEN RetainPrune(dead) ELSE reg \ dead
    /\ UNCHANGED <<procs, nb, used, st, hp, hb, kidsN, pend, rpc, rkill, rprune, bpc, bkill, wrong>>

\* ---- the registry-driven sweep ---------------------------------------------
RDecide(r) ==
    /\ rpc[r] = "idle"
    /\ \E scanOk \in (IF ScanFail THEN BOOLEAN ELSE {TRUE}) :
        LET dead  == {e \in reg : HostDead(e)}
            stale == {e \in reg \ dead : e.stale}
            kills == {k \in UNION {e.kids : e \in dead} :
                        procs[k.p].k # "free" /\ scanOk /\ Match(k)}
        IN /\ dead \cup stale # {}
           /\ rkill' = [rkill EXCEPT ![r] = kills]
           /\ rprune' = [rprune EXCEPT ![r] =
                  {[p |-> e.p, hb |-> e.hb] : e \in dead \cup (IF StalePrune THEN stale ELSE {})}]
    /\ rpc' = [rpc EXCEPT ![r] = "kill"]
    /\ UNCHANGED <<procs, nb, used, st, hp, hb, kidsN, pend, reg, bpc, bkill, wrong>>

RKill(r) ==
    /\ rpc[r] = "kill"
    /\ \E k \in rkill[r] :
        /\ rkill' = [rkill EXCEPT ![r] = @ \ {k}]
        /\ IF Recheck /\ ~(procs[k.p].k # "free" /\ Match(k))
           THEN UNCHANGED <<procs, wrong>>
           ELSE DoKill(k.p)
    /\ UNCHANGED <<nb, used, st, hp, hb, kidsN, pend, reg, rpc, rprune, bpc, bkill>>

\* pruneDeadInstances(prunePids): re-read under the lock, drop by pid.
RPrune(r) ==
    /\ rpc[r] = "kill" /\ rkill[r] = {}
    /\ LET S == {e \in reg : \E x \in rprune[r] : x.p = e.p /\ (Birth => x.hb = e.hb)}
       IN reg' = IF Retain THEN RetainPrune(S) ELSE reg \ S
    /\ rpc' = [rpc EXCEPT ![r] = "idle"]
    /\ rprune' = [rprune EXCEPT ![r] = {}]
    /\ UNCHANGED <<procs, nb, used, st, hp, hb, kidsN, pend, rkill, bpc, bkill, wrong>>

\* ---- the backstop -----------------------------------------------------------
BDecide(b) ==
    /\ bpc[b] = "idle"
    /\ ("lock" \in Guards => \A o \in Backstops : bpc[o] = "idle")
    /\ LET elig == {p \in Pids \ {0} : BackstopCandidate(p)}
       IN /\ elig # {}
          /\ bkill' = [bkill EXCEPT ![b] = {[p |-> p, b |-> procs[p].b] : p \in elig}]
    /\ bpc' = [bpc EXCEPT ![b] = "kill"]
    /\ UNCHANGED <<procs, nb, used, st, hp, hb, kidsN, pend, reg, rpc, rkill, rprune, wrong>>

BKill(b) ==
    /\ bpc[b] = "kill"
    /\ \E x \in bkill[b] :
        /\ bkill' = [bkill EXCEPT ![b] = @ \ {x}]
        /\ IF Recheck /\ ~(BackstopCandidate(x.p) /\ (Birth => procs[x.p].b = x.b))
           THEN UNCHANGED <<procs, wrong>>
           ELSE DoKill(x.p)
    /\ UNCHANGED <<nb, used, st, hp, hb, kidsN, pend, reg, rpc, rkill, rprune, bpc>>

BDone(b) ==
    /\ bpc[b] = "kill" /\ bkill[b] = {}
    /\ bpc' = [bpc EXCEPT ![b] = "idle"]
    /\ UNCHANGED <<procs, nb, used, st, hp, hb, kidsN, pend, reg, rpc, rkill, rprune, bkill, wrong>>

Next ==
    \/ \E i \in Insts : Start(i) \/ Register(i) \/ Spawn(i) \/ Record(i) \/ Crash(i) \/ Exit(i)
    \/ \E p \in Pids \ {0} : LspExit(p) \/ OtherExit(p) \/ Age(p)
    \/ OtherStart \/ GoStale \/ Footprint
    \/ \E r \in Reapers : RDecide(r) \/ RKill(r) \/ RPrune(r)
    \/ \E b \in Backstops : BDecide(b) \/ BKill(b) \/ BDone(b)

Spec == Init /\ [][Next]_vars

-----------------------------------------------------------------------------
(* Invariants *)

\* The reaper never kills a process that is not an orphan: a live
\* instance's host or LSP child, or an unrelated process on a reused pid.
NoWrongKill == ~wrong

\* Leak bound: every orphan still has a path to a kill. Either an entry
\* lists it under its identity (the registry sweep will judge that entry
\* once its pid is dead), or the backstop's own test accepts it.
Listed(p) ==
    \E e \in reg : \E k \in e.kids :
        k.p = p /\ k.c \in procs[p].t /\ (Birth => k.b = procs[p].b)
BackstopReaches(p) ==
    /\ ("tracked" \in Guards => ~Tracked(p))
    /\ PPDead(p)
OrphanReachable ==
    \A p \in Pids \ {0} : Orphan(p) => Listed(p) \/ BackstopReaches(p)
=============================================================================
