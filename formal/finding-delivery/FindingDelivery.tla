------------------------------ MODULE FindingDelivery ------------------------------
(***************************************************************************
The finding-delivery gate stack (#1634, clients/finding-delivery-gate.ts),
seen from the stores that route through it, for one cited file and one
finding per store (#4715).

Two stores, either or both active (Kinds):
 - "pending": the cascade's pending neighbour-error record
   (clients/cascade-format.ts, rendered by clients/runtime-turn.ts
   handleTurnEnd). A run that reads the file lists its errors; a later turn
   whose run did not observe the file renders the record through the
   freshness gate (gateFindingsByPathFreshness, quiet, per-entry
   scannedAtOf: checkedAt).
 - "cached": a scanner store re-served every turn (govulncheck, gitleaks,
   trivy-secrets; clients/turn-end/lanes/*.ts). The composer's shared
   freshness pass partitions its findings, then the lane's gate applies the
   stored dispositions over BOTH arms.

The gate stack, in order, per delivery: the freshness verdict of the cited
path against the entry's stamp (missing / stale / live), then the
disposition policy over what the gate returned, then the render. The order
is structural (lane.gate receives the partition), so the model has no switch
for it.

Time is a logical clock: every write, read, scan and delivery takes the next
tick, so "written after the read" is mt > readAt. The 50 ms drift tolerance
(MTIME_DRIFT_TOLERANCE_MS) is store-freshness's ToleranceWindow, not this
model's.

Ground truth versus the gate's view. `readAt` is when the file was really
read. `at` is the stamp the gate judges against. They differ only under
StampAt = "delivery". Every violation flag is computed from `readAt` and the
file, never from `at`, so a wrong stamp cannot excuse itself.

Actions:
 - Write(lc, b): the file is written by something pi never saw (git
   checkout, an external editor or formatter). `lc` says whether the flagged
   line's content changed; `b` is the file's new verdict.
 - Delete: the file is deleted.
 - Edit(cov): a turn's cascade run; it observes the file when `cov`.
 - Scan: the scanner store takes a scan (stamped at its start).
 - Mark: the agent marks the cached finding false-positive; the anchor is
   the line content the finding cites.
 - TurnEnd: one turn_end delivery for both stores.

Invariants (each has a mutant config that violates it):
 - NoUnresolvedAfterWrite: the pending record never renders a neighbour
   "unresolved" when the file was written after the read behind it
   (297000e11, StampAt).
 - NoUnresolvedAfterDelete: ... or when it was deleted (0aaddeb79,
   NeighbourGate).
 - NoSilentForget: a written neighbour's record is never forgotten without
   the "changed since checked" line (demote, never drop; NeighbourGate).
 - PersistentListed: an error the record holds, on an unchanged file that
   no run observed this turn, is rendered again (123510076, Reserve).
 - ListedWhenObserved: an error a run observes is listed on every run
   (123510076, Delta).
 - MarkedNeverShown: a finding whose mark still applies to the file is
   delivered on neither freshness arm (PolicyArms).
 - NoSuppressRewritten: a false-positive mark does not suppress a finding
   whose flagged line was rewritten (Anchor).
 - NamedOnce: a "changed since checked" line forgets its entry
   (NeighbourGate).
 - NoNamedAfterDelete: a deleted neighbour is forgotten silently, never
   named as changed (NeighbourGate).
 - CleanClears: a clean observation newer than the record clears it
   (ClearOnClean).
 - NoCachedAfterDelete: a deleted file's cached finding is delivered on no
   arm (CachedGate, onMissing "drop").
 - NoStaleCachedAtFull: a cached finding is never delivered at full
   authority when its file was written after the scan (CachedGate).
 - NoCachedStaleDrop: a stale cached finding is demoted, never dropped
   (CachedGate).
 - TypeOK.
***************************************************************************)
EXTENDS Naturals

CONSTANTS
    Kinds,          \* the active stores: a subset of {"pending", "cached"}
    OutsideKinds,   \* which outside changes: a subset of {"write", "delete"}
    CanMark,        \* the agent may mark the cached finding
    MaxClk,         \* ticks explored
    MaxTurns,       \* turns explored
    StampAt,        \* "read"     the pending record is stamped with the run's
                    \*            read bound (CascadeRun.checkedAt)
                    \* "delivery" it is stamped with turn_end's delivery time
                    \*            (#4495 round 2)
    NeighbourGate,  \* "freshness" turn_end passes each record entry through
                    \*             the freshness gate: a written neighbour is
                    \*             named once and forgotten, a deleted one
                    \*             forgotten silently
                    \* "drop"      both forgotten silently (#4495 round 2)
                    \* "none"      the record renders whatever happened to
                    \*             the file (#4495 round 1)
                    \* "keepNamed"   a written neighbour is named but kept, so
                    \*             it is named again (mutant only)
                    \* "nameDeleted" a deleted neighbour is named as changed
                    \*             instead of forgotten (mutant only)
    Reserve,        \* "record" a delivered error stays on the unresolved
                    \*          line until a newer observation clears it
                    \* "none"   no record (pre-#4487)
    Delta,          \* "none"    every observed error is listed on every run
                    \* "rolling" an error listed on the previous run is hidden
                    \*          (pre-#4487)
    PolicyArms,     \* "both"     dispositions apply to the live and the stale
                    \*            arm (#1617, #1625: an fp-marked finding
                    \*            that goes stale must not reappear)
                    \* "liveOnly" they apply to the live arm only
    Anchor,         \* "line" a false-positive mark applies only while the
                    \*        flagged line's content is the one marked
                    \*        (diagnostic-dispositions.ts, strict anchor)
                    \* "none" it applies whatever the line holds
    ClearOnClean,   \* "clear" a clean observation newer than the record
                    \*         clears it (forgetCascadePendingNeighbor)
                    \* "keep"  it never does
    CachedGate      \* "freshness"  the cached store's findings pass the
                    \*              freshness gate: missing is dropped, stale
                    \*              is demoted, live is delivered
                    \* "noStale"    no stale verdict (stale reads live)
                    \* "keepMissing" no missing verdict (a deleted file's
                    \*              finding is delivered)
                    \* "dropStale"  stale is dropped, not demoted

VARIABLES
    clk,        \* the logical clock
    turn,       \* 1..MaxTurns + 1
    phase,      \* "idle" | "observed" (a cascade run happened this turn)
    exists,     \* the cited file exists
    mt,         \* its last write tick
    gen,        \* the flagged line's content generation
    bad,        \* the file's current content has the error
    rec,        \* the pending record entry
    obs,        \* this turn's run observation of the neighbour
    lastListed, \* the previous run listed the error (the Delta baseline)
    store,      \* the cached store's finding
    mark,       \* the agent marked the cached finding false-positive
    markGen,    \* the line generation the mark anchors to
    outP,       \* what the pending record rendered last turn_end
    outC,       \* what the cached store rendered last turn_end
    v           \* [flag -> BOOLEAN]: a violation seen at some delivery

vars == <<clk, turn, phase, exists, mt, gen, bad, rec, obs, lastListed, store,
          mark, markGen, outP, outC, v>>

Ticks == 0..MaxClk
Rec == [has : BOOLEAN, readAt : Ticks, at : Ticks, gen : Ticks]
Obs == [on : BOOLEAN, readAt : Ticks, gen : Ticks, bad : BOOLEAN]
OutP == {"none", "full", "unresolved", "named"}
OutC == {"none", "full", "demoted", "suppressed", "dropped"}
Flags == {"write", "delete", "forget", "persist", "listed", "marked", "rewritten",
          "namedGone", "namedKept", "stuck", "cGone", "cFull", "cDrop"}

NoRec == [has |-> FALSE, readAt |-> 0, at |-> 0, gen |-> 0]
NoObs == [on |-> FALSE, readAt |-> 0, gen |-> 0, bad |-> FALSE]

TypeOK ==
    /\ clk \in Ticks
    /\ turn \in 1..(MaxTurns + 1)
    /\ phase \in {"idle", "observed"}
    /\ exists \in BOOLEAN
    /\ mt \in Ticks
    /\ gen \in Ticks
    /\ bad \in BOOLEAN
    /\ rec \in Rec
    /\ obs \in Obs
    /\ lastListed \in BOOLEAN
    /\ store \in Rec
    /\ mark \in BOOLEAN
    /\ markGen \in Ticks
    /\ outP \in OutP
    /\ outC \in OutC
    /\ v \in [Flags -> BOOLEAN]

Init ==
    /\ clk = 0
    /\ turn = 1
    /\ phase = "idle"
    /\ exists = TRUE
    /\ mt = 0
    /\ gen = 0
    /\ bad = TRUE
    /\ rec = NoRec
    /\ obs = NoObs
    /\ lastListed = FALSE
    /\ store = NoRec
    /\ mark = FALSE
    /\ markGen = 0
    /\ outP = "none"
    /\ outC = "none"
    /\ v = [f \in Flags |-> FALSE]

Open == turn <= MaxTurns /\ clk < MaxClk

\* Write(lc, b): an outside write.
Write(lc, b) ==
    /\ "write" \in OutsideKinds
    /\ Open /\ exists
    /\ clk' = clk + 1
    /\ mt' = clk + 1
    /\ gen' = IF lc THEN gen + 1 ELSE gen
    /\ bad' = b
    /\ UNCHANGED <<turn, phase, exists, rec, obs, lastListed, store, mark,
                   markGen, outP, outC, v>>

\* Delete: an outside deletion.
Delete ==
    /\ "delete" \in OutsideKinds
    /\ Open /\ exists
    /\ clk' = clk + 1
    /\ exists' = FALSE
    /\ mt' = clk + 1
    /\ UNCHANGED <<turn, phase, gen, bad, rec, obs, lastListed, store, mark,
                   markGen, outP, outC, v>>

\* Edit(cov): the turn's cascade run (dispatch/integration.ts
\* computeCascadeForFile). It reads the neighbour when `cov`.
Edit(cov) ==
    /\ "pending" \in Kinds
    /\ phase = "idle"
    /\ Open
    /\ cov => exists
    /\ clk' = clk + 1
    /\ phase' = "observed"
    /\ obs' = IF cov THEN [on |-> TRUE, readAt |-> clk + 1, gen |-> gen, bad |-> bad]
              ELSE NoObs
    /\ UNCHANGED <<turn, exists, mt, gen, bad, rec, lastListed, store, mark,
                   markGen, outP, outC, v>>

\* Scan: the scanner takes a scan; the store's scannedAt is its start.
Scan ==
    /\ "cached" \in Kinds
    /\ phase = "idle"
    /\ Open /\ exists
    /\ clk' = clk + 1
    /\ store' = [has |-> bad, readAt |-> clk + 1, at |-> clk + 1, gen |-> gen]
    /\ UNCHANGED <<turn, phase, exists, mt, gen, bad, rec, obs, lastListed,
                   mark, markGen, outP, outC, v>>

\* Mark: lens_diagnostic_mark, false-positive. The tool reads the file as it
\* is now and anchors to that content's line (tools/lens-diagnostic-mark.ts,
\* diagnostic-dispositions.ts), so the anchor is the current generation.
Mark ==
    /\ "cached" \in Kinds
    /\ CanMark /\ store.has /\ ~mark
    /\ mark' = TRUE
    /\ markGen' = gen
    /\ UNCHANGED <<clk, turn, phase, exists, mt, gen, bad, rec, obs,
                   lastListed, store, outP, outC, v>>

\* TurnEnd: one turn_end delivery (runtime-turn.ts handleTurnEnd).
TurnEnd ==
    /\ Open
    /\ LET d == clk + 1
           o == obs
           r == rec
           writtenAfter(t) == exists /\ mt > t
           \* --- the pending record -------------------------------------
           runPending == "pending" \in Kinds /\ phase = "observed"
           pVerdict == IF ~exists
                          THEN (IF NeighbourGate = "nameDeleted" THEN "stale" ELSE "missing")
                       ELSE IF mt > r.at THEN "stale" ELSE "live"
           pGate == IF NeighbourGate = "none" THEN "live" ELSE pVerdict
           listed == o.on /\ o.bad /\ ~(Delta = "rolling" /\ lastListed)
           pOut == IF ~runPending THEN "none"
                   ELSE IF o.on THEN (IF listed THEN "full" ELSE "none")
                   ELSE IF ~r.has \/ Reserve = "none" THEN "none"
                   ELSE IF pGate = "live" THEN "unresolved"
                   ELSE IF pGate = "stale"
                           /\ NeighbourGate \in {"freshness", "keepNamed", "nameDeleted"}
                        THEN "named"
                   ELSE "none"
           \* the record takes the observation (recordDeliveredCascadeNeighbor,
           \* stamped with the read bound or the delivery time); a clean
           \* observation newer than the record clears it; an entry the gate
           \* retired is forgotten (named once, or silently)
           pRec == IF ~runPending THEN r
                   ELSE IF o.on
                        THEN (IF o.bad
                                 THEN [has |-> TRUE, readAt |-> o.readAt,
                                       at |-> IF StampAt = "read" THEN o.readAt ELSE d,
                                       gen |-> o.gen]
                              ELSE IF o.readAt > r.readAt /\ ClearOnClean = "clear"
                                   THEN NoRec
                              ELSE r)
                   ELSE IF ~r.has \/ Reserve = "none" THEN r
                   ELSE IF pGate = "live"
                           \/ (pGate = "stale" /\ NeighbourGate = "keepNamed")
                        THEN r
                   ELSE NoRec
           \* --- the cached store ---------------------------------------
           cVerdict == IF CachedGate = "noStale"
                          THEN (IF ~exists THEN "missing" ELSE "live")
                       ELSE IF CachedGate = "keepMissing"
                          THEN (IF exists /\ mt > store.at THEN "stale" ELSE "live")
                       ELSE IF ~exists THEN "missing"
                       ELSE IF mt > store.at THEN "stale" ELSE "live"
           applies == mark /\ (Anchor = "none" \/ markGen = gen)
           cOut == IF ~("cached" \in Kinds) \/ ~store.has THEN "none"
                   ELSE IF cVerdict = "missing"
                           \/ (cVerdict = "stale" /\ CachedGate = "dropStale")
                        THEN "dropped"
                   ELSE IF applies /\ (cVerdict = "live" \/ PolicyArms = "both")
                        THEN "suppressed"
                   ELSE IF cVerdict = "live" THEN "full"
                   ELSE "demoted"
       IN
       /\ outP' = pOut
       /\ rec' = pRec
       /\ lastListed' = IF runPending THEN (o.on /\ o.bad) ELSE lastListed
       /\ outC' = cOut
       /\ v' = [write |-> (v.write \/ (pOut = "unresolved" /\ writtenAfter(r.readAt))),
                delete |-> (v.delete \/ (pOut = "unresolved" /\ ~exists)),
                forget |-> (v.forget \/ (runPending /\ ~o.on /\ r.has /\ ~pRec.has
                                        /\ writtenAfter(r.readAt) /\ pOut # "named")),
                persist |-> (v.persist \/ (runPending /\ ~o.on /\ r.has /\ exists
                                          /\ ~writtenAfter(r.readAt)
                                          /\ pOut # "unresolved")),
                listed |-> (v.listed \/ (runPending /\ o.on /\ o.bad /\ pOut # "full")),
                marked |-> (v.marked \/ (cOut \in {"full", "demoted"}
                                        /\ mark /\ markGen = gen)),
                rewritten |-> (v.rewritten \/ (cOut = "suppressed" /\ markGen # gen)),
                namedGone |-> (v.namedGone \/ (pOut = "named" /\ ~exists)),
                namedKept |-> (v.namedKept \/ (pOut = "named" /\ pRec.has)),
                stuck |-> (v.stuck \/ (runPending /\ o.on /\ ~o.bad /\ r.has
                                      /\ o.readAt > r.readAt /\ pRec.has)),
                cGone |-> (v.cGone \/ (cOut \in {"full", "demoted", "suppressed"}
                                      /\ ~exists)),
                cFull |-> (v.cFull \/ (cOut = "full" /\ writtenAfter(store.readAt))),
                cDrop |-> (v.cDrop \/ (cOut = "dropped" /\ exists))]
       /\ clk' = d
    /\ turn' = turn + 1
    /\ phase' = "idle"
    /\ obs' = NoObs
    /\ UNCHANGED <<exists, mt, gen, bad, store, mark, markGen>>

Next ==
    \/ \E lc \in BOOLEAN, b \in BOOLEAN: Write(lc, b)
    \/ Delete
    \/ \E cov \in BOOLEAN: Edit(cov)
    \/ Scan
    \/ Mark
    \/ TurnEnd

Spec == Init /\ [][Next]_vars

NoUnresolvedAfterWrite == ~v.write
NoUnresolvedAfterDelete == ~v.delete
NoSilentForget == ~v.forget
PersistentListed == ~v.persist
ListedWhenObserved == ~v.listed
NamedOnce == ~v.namedKept
NoNamedAfterDelete == ~v.namedGone
CleanClears == ~v.stuck
MarkedNeverShown == ~v.marked
NoSuppressRewritten == ~v.rewritten
NoCachedAfterDelete == ~v.cGone
NoStaleCachedAtFull == ~v.cFull
NoCachedStaleDrop == ~v.cDrop
=============================================================================
