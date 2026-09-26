---------------------------- MODULE LateAuxDrain ----------------------------
(***************************************************************************)
(* Turn-end drain of late auxiliary-scanner results (#2001/#2002) for ONE  *)
(* (file, server) pair.                                                    *)
(*                                                                         *)
(* Actors:                                                                 *)
(*  - agent touches (clients/lsp/index.ts touchFile, with-auxiliary): the  *)
(*    agent writes version v, the aux client clears its cached entry       *)
(*    (client.ts clearDiagnosticsForPath, run on every resync) and sends   *)
(*    v, unless the #1459 gate defers the write. The aux-grace wait later  *)
(*    decides the outcome from per-path publication evidence (any publish  *)
(*    since the pre-notify baseline = "answered") and, with no evidence,   *)
(*    marks the pair with markedAtMs = Date.now() (index.ts ~6025). A      *)
(*    producer re-mark of an existing pair moves the baseline              *)
(*    (pending-aux-coverage.ts markPendingAuxiliaryCoverage, #2027);       *)
(*  - external edits (another session, a shell write): the disk changes,   *)
(*    nothing is sent to the scanner, nothing is marked;                   *)
(*  - the scanner (opengrep): scans what it was sent, in order, and        *)
(*    publishes WITHOUT a version. The client stores the publish with      *)
(*    ts = receipt time; isSupersededPush cannot drop a version-less push  *)
(*    (client.ts ~2440-2480). It may skip a superseded scan (AllowCancel); *)
(*  - opengrep's rule refresh (#3490, opengrep@1a5fd9d                     *)
(*    Scan_helpers.refresh_rules): `semgrep/rulesRefreshed`, then one      *)
(*    SURPLUS publish per file with a recorded scan. It answers no send.   *)
(*    It may overtake scans sent before the notification, never one sent  *)
(*    after it, and carries the newest version sent before the            *)
(*    notification (opengrep reads the disk; not modelled);               *)
(*  - the turn_end drain (runtime-turn.ts ~3895-4220):                     *)
(*      DrainStart   drainPendingAuxiliaryCoverage (sync)                  *)
(*      DrainRead    await readCachedDiagnosticsForServers, then the sync  *)
(*                   `publishedAt <= markedAtMs` -> re-arm check           *)
(*      DrainGate    after `await bounded(observeLateAuxiliaryAnswer)`:    *)
(*                   readFileSync + gateFindingsByPathFreshness (statSync, *)
(*                   stale iff mtime > markedAtMs + tolerance), deliver.   *)
(*                   A stale verdict re-arms with a REFRESHED baseline     *)
(*                   (rearmPendingAuxiliaryCoverage(pair, now, true)).     *)
(*                                                                         *)
(* Timestamps are a logical clock: every timestamped event takes clock+1. *)
(* Agent touches do not overlap the drain (turn_end runs after the turn's  *)
(* tools); external edits and scanner publishes may happen at any step.    *)
(***************************************************************************)
EXTENDS Naturals, Sequences

CONSTANTS
    AgentTouches,     \* agent edits that go through touchFile
    ExternalEdits,    \* edits nothing is sent for
    MaxDrains,        \* turn_end drains
    MaxRearms,        \* MAX_LATE_AUX_REARMS (bounded small)
    Tol,              \* MTIME_DRIFT_TOLERANCE_MS, in clock ticks
    AllowDefer,       \* the #1459 gate may defer a touch's write
    AllowCancel,      \* the scanner may skip a superseded scan
    PublishedAtCheck, \* today TRUE: `publishedAt <= markedAtMs` -> wait
    MtimeGate,        \* today TRUE: gateFindingsByPathFreshness
    RefreshOnStale,   \* today TRUE: stale re-arm refreshes the baseline
    CountBind,        \* candidate fix: pair records the scanner's backlog at
                      \* mark; deliver only once that many publishes landed
    MarkAtNotify,     \* candidate fix: markedAtMs = the touch's notify time,
                      \* not Date.now() after the grace wait (index.ts ~6028)
    ExtDuringGrace,   \* external edits may land inside a touch's aux-grace wait
    Refresh,          \* "none" | "answered" | "outstanding": one
                      \* semgrep/rulesRefreshed, arriving after v0's first
                      \* answer ("answered") or while it is in flight
    RefreshRebaseline \* #3490: the notification takes one publication back
                      \* from a path that already had one

None == [none |-> TRUE]

VARIABLES
    clock,
    disk,        \* version on disk (1 = initial content)
    mtime,
    touchesLeft, extLeft, drainsLeft,
    touch,       \* "idle" | "grace"
    touchVer,    \* version the touch in grace sent (0 = deferred)
    touchBase,   \* per-path publication count before the notify
    touchAt,     \* clock at the touch's notify
    sent,        \* versions sent to the scanner, not yet scanned
    pubCount,    \* publications received for the path (monotone): the
                 \* touch's evidence
    sentCount,   \* sends in the open lifetime, v0's open included (client.ts
                 \* publicationCountsForPath `sent`)
    bound,       \* the client's publication count, capped at sentCount
                 \* (`published`): what the backlog binding reads
    lastSent,    \* newest version sent to the scanner
    refresh,     \* "pending" | "notified" | "done"
    surplus,     \* version the refresh republish carries (0 = none)
    preN,        \* scans sent before the notification, still queued
    cache,       \* None | [ver, ts]  (ver is invisible to the code)
    pending,     \* None | [marked, rearms, need, seq]
    drain,       \* "idle" | "read" | "observe"
    pair,        \* the drained pair
    snap,        \* the cache entry readCachedDiagnosticsForServers returned
    delivered    \* set of [ver, disk]: findings delivered, disk at the gate

vars == <<clock, disk, mtime, touchesLeft, extLeft, drainsLeft, touch, touchVer,
          touchBase, touchAt, sent, pubCount, cache, pending, drain, pair, snap, delivered,
          sentCount, bound, lastSent, refresh, surplus, preN>>

refreshVars == <<refresh, surplus, preN>>

\* countPublication: one more publication, capped at the lifetime's sends.
Counted(b) == IF b + 1 > sentCount THEN sentCount ELSE b + 1

Init ==
    /\ clock = 0 /\ disk = 1 /\ mtime = 0
    /\ touchesLeft = AgentTouches /\ extLeft = ExternalEdits /\ drainsLeft = MaxDrains
    /\ touch = "idle" /\ touchVer = 0 /\ touchBase = 0 /\ touchAt = 0
    \* v0 is open (one send); its first answer landed, or is in flight.
    /\ sent = IF Refresh = "outstanding" THEN <<1>> ELSE << >>
    /\ sentCount = 1 /\ lastSent = 1
    /\ bound = IF Refresh = "outstanding" THEN 0 ELSE 1
    /\ refresh = IF Refresh = "none" THEN "done" ELSE "pending"
    /\ surplus = 0 /\ preN = 0
    /\ pubCount = 0 /\ cache = None
    /\ pending = None /\ drain = "idle" /\ pair = None /\ snap = None
    /\ delivered = {}

-----------------------------------------------------------------------------
\* Agent edit + touch notify. The write and the notify are one step: the
\* touch sends the content the agent wrote, whatever the disk holds later.
AgentTouch ==
    /\ touchesLeft > 0 /\ touch = "idle" /\ drain = "idle"
    /\ touchesLeft' = touchesLeft - 1
    /\ disk' = disk + 1 /\ clock' = clock + 1 /\ mtime' = clock + 1
    /\ touch' = "grace" /\ touchBase' = pubCount /\ touchAt' = clock + 1
    /\ \/ \* sent: clearDiagnosticsForPath, then didChange / reopen
          /\ touchVer' = disk + 1
          /\ sent' = Append(sent, disk + 1)
          /\ sentCount' = sentCount + 1 /\ lastSent' = disk + 1
          /\ cache' = None
       \/ \* #1459 deferred: never sent, never cleared, never marked
          /\ AllowDefer
          /\ touchVer' = 0
          /\ UNCHANGED <<sent, sentCount, lastSent, cache>>
    /\ UNCHANGED <<extLeft, drainsLeft, pubCount, pending, drain, pair, snap, delivered,
                   bound, refreshVars>>

\* Aux-grace outcome and mark: evidence check, filter and mark run in one
\* continuation (index.ts ~5920-6030), so one step.
GraceEnd ==
    /\ touch = "grace"
    /\ touch' = "idle"
    /\ IF touchVer = 0 \/ pubCount > touchBase
         THEN UNCHANGED <<pending, clock>>           \* deferred / "answered"
         ELSE /\ clock' = clock + 1                  \* cut_off / silent: mark
              /\ pending' = [marked |-> IF MarkAtNotify THEN touchAt ELSE clock + 1,
                             rearms |-> 0,
                             need |-> sentCount - bound, seq |-> bound]
    /\ UNCHANGED <<disk, mtime, touchesLeft, extLeft, drainsLeft, touchVer, touchBase, touchAt,
                   sent, pubCount, cache, drain, pair, snap, delivered,
                   sentCount, bound, lastSent, refreshVars>>

ExternalEdit ==
    /\ extLeft > 0
    /\ ExtDuringGrace \/ touch = "idle"
    /\ extLeft' = extLeft - 1
    /\ disk' = disk + 1 /\ clock' = clock + 1 /\ mtime' = clock + 1
    /\ UNCHANGED <<touchesLeft, drainsLeft, touch, touchVer, touchBase, touchAt, sent,
                   pubCount, cache, pending, drain, pair, snap, delivered,
                   sentCount, bound, lastSent, refreshVars>>

\* The scanner finishes the oldest outstanding scan; the client stores it.
Publish ==
    /\ sent /= << >>
    /\ surplus = 0 \/ preN > 0          \* a later send waits for the republish
    /\ clock' = clock + 1
    /\ cache' = [ver |-> Head(sent), ts |-> clock + 1]
    /\ pubCount' = pubCount + 1
    /\ bound' = Counted(bound)
    /\ sent' = Tail(sent)
    /\ preN' = IF preN > 0 THEN preN - 1 ELSE 0
    /\ UNCHANGED <<disk, mtime, touchesLeft, extLeft, drainsLeft, touch, touchVer,
                   touchBase, touchAt, pending, drain, pair, snap, delivered,
                   sentCount, lastSent, refresh, surplus>>

CancelSuperseded ==
    /\ AllowCancel /\ Len(sent) > 1
    /\ sent' = Tail(sent)
    /\ preN' = IF preN > 0 THEN preN - 1 ELSE 0
    /\ UNCHANGED <<clock, disk, mtime, touchesLeft, extLeft, drainsLeft, touch,
                   touchVer, touchBase, touchAt, pubCount, cache, pending, drain, pair, snap, delivered,
                   sentCount, bound, lastSent, refresh, surplus>>

\* semgrep/rulesRefreshed arrives. RefreshRebaseline is #3490's
\* rebaselineForRulesRefresh: a path with a count entry (one publication
\* counted this lifetime) gives one back.
RulesRefreshed ==
    /\ refresh = "pending"
    /\ refresh' = "notified"
    /\ surplus' = lastSent
    /\ preN' = Len(sent)
    /\ bound' = IF RefreshRebaseline /\ bound >= 1 THEN bound - 1 ELSE bound
    /\ UNCHANGED <<clock, disk, mtime, touchesLeft, extLeft, drainsLeft, touch, touchVer,
                   touchBase, touchAt, sent, pubCount, cache, pending, drain, pair, snap,
                   delivered, sentCount, lastSent>>

\* The refresh republish: stored and counted like any version-less publish.
SurplusPublish ==
    /\ refresh = "notified"
    /\ refresh' = "done" /\ surplus' = 0 /\ preN' = 0
    /\ clock' = clock + 1
    /\ cache' = [ver |-> surplus, ts |-> clock + 1]
    /\ pubCount' = pubCount + 1
    /\ bound' = Counted(bound)
    /\ UNCHANGED <<disk, mtime, touchesLeft, extLeft, drainsLeft, touch, touchVer,
                   touchBase, touchAt, sent, pending, drain, pair, snap, delivered,
                   sentCount, lastSent>>

-----------------------------------------------------------------------------
\* rearmPendingAuxiliaryCoverage; past the ceiling the pair drops.
Rearm(p, fresh) ==
    pending' = IF p.rearms >= MaxRearms THEN None
               ELSE IF fresh
                 THEN [marked |-> clock + 1, rearms |-> p.rearms + 1,
                       need |-> sentCount - bound, seq |-> bound]
                 ELSE [p EXCEPT !.rearms = p.rearms + 1]

DrainStart ==
    /\ drain = "idle" /\ touch = "idle" /\ drainsLeft > 0 /\ pending /= None
    /\ drainsLeft' = drainsLeft - 1
    /\ pair' = pending /\ pending' = None /\ drain' = "read"
    /\ UNCHANGED <<clock, disk, mtime, touchesLeft, extLeft, touch, touchVer,
                   touchBase, touchAt, sent, pubCount, cache, snap, delivered,
                   sentCount, bound, lastSent, refreshVars>>

\* readCachedDiagnosticsForServers resolves with the cached entry, then the
\* synchronous freshness check.
DrainRead ==
    /\ drain = "read"
    /\ snap' = cache
    /\ LET waitIt == \/ cache = None
                     \/ PublishedAtCheck /\ cache.ts <= pair.marked
                     \/ CountBind /\ bound - pair.seq < pair.need
       IN IF waitIt
            THEN /\ Rearm(pair, FALSE) /\ drain' = "idle"
            ELSE /\ drain' = "observe" /\ UNCHANGED pending
    /\ UNCHANGED <<clock, disk, mtime, touchesLeft, extLeft, drainsLeft, touch,
                   touchVer, touchBase, touchAt, sent, pubCount, cache, pair, delivered,
                   sentCount, bound, lastSent, refreshVars>>

\* After `await bounded(observeLateAuxiliaryAnswer)`: read + stat + deliver,
\* all synchronous.
DrainGate ==
    /\ drain = "observe"
    /\ drain' = "idle"
    /\ IF MtimeGate /\ mtime > pair.marked + Tol
         THEN /\ Rearm(pair, RefreshOnStale)
              /\ clock' = clock + 1
              /\ UNCHANGED delivered
         ELSE /\ delivered' = delivered \cup {[ver |-> snap.ver, disk |-> disk]}
              /\ UNCHANGED <<pending, clock>>
    /\ UNCHANGED <<disk, mtime, touchesLeft, extLeft, drainsLeft, touch, touchVer,
                   touchBase, touchAt, sent, pubCount, cache, pair, snap,
                   sentCount, bound, lastSent, refreshVars>>

Next == AgentTouch \/ GraceEnd \/ ExternalEdit \/ Publish \/ CancelSuperseded
        \/ RulesRefreshed \/ SurplusPublish
        \/ DrainStart \/ DrainRead \/ DrainGate

Spec == Init /\ [][Next]_vars

-----------------------------------------------------------------------------
\* The comment's promise (runtime-turn.ts ~4070, ~4132): "a changed file
\* cannot resurrect stale data". Findings delivered were computed on the
\* content that was on disk when the drain checked it.
NoStaleFindings == \A d \in delivered : d.ver = d.disk

\* Sanity: the drain can deliver at all (checked as a violated "invariant").
NeverDelivers == delivered = {}
=============================================================================
