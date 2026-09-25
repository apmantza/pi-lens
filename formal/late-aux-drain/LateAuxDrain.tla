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
    ExtDuringGrace    \* external edits may land inside a touch's aux-grace wait

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
    pubCount,    \* publications received for the path (monotone)
    cache,       \* None | [ver, ts]  (ver is invisible to the code)
    pending,     \* None | [marked, rearms, need, seq]
    drain,       \* "idle" | "read" | "observe"
    pair,        \* the drained pair
    snap,        \* the cache entry readCachedDiagnosticsForServers returned
    delivered    \* set of [ver, disk]: findings delivered, disk at the gate

vars == <<clock, disk, mtime, touchesLeft, extLeft, drainsLeft, touch, touchVer,
          touchBase, touchAt, sent, pubCount, cache, pending, drain, pair, snap, delivered>>

Init ==
    /\ clock = 0 /\ disk = 1 /\ mtime = 0
    /\ touchesLeft = AgentTouches /\ extLeft = ExternalEdits /\ drainsLeft = MaxDrains
    /\ touch = "idle" /\ touchVer = 0 /\ touchBase = 0 /\ touchAt = 0
    /\ sent = << >> /\ pubCount = 0 /\ cache = None
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
          /\ cache' = None
       \/ \* #1459 deferred: never sent, never cleared, never marked
          /\ AllowDefer
          /\ touchVer' = 0
          /\ UNCHANGED <<sent, cache>>
    /\ UNCHANGED <<extLeft, drainsLeft, pubCount, pending, drain, pair, snap, delivered>>

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
                             need |-> Len(sent), seq |-> pubCount]
    /\ UNCHANGED <<disk, mtime, touchesLeft, extLeft, drainsLeft, touchVer, touchBase, touchAt,
                   sent, pubCount, cache, drain, pair, snap, delivered>>

ExternalEdit ==
    /\ extLeft > 0
    /\ ExtDuringGrace \/ touch = "idle"
    /\ extLeft' = extLeft - 1
    /\ disk' = disk + 1 /\ clock' = clock + 1 /\ mtime' = clock + 1
    /\ UNCHANGED <<touchesLeft, drainsLeft, touch, touchVer, touchBase, touchAt, sent,
                   pubCount, cache, pending, drain, pair, snap, delivered>>

\* The scanner finishes the oldest outstanding scan; the client stores it.
Publish ==
    /\ sent /= << >>
    /\ clock' = clock + 1
    /\ cache' = [ver |-> Head(sent), ts |-> clock + 1]
    /\ pubCount' = pubCount + 1
    /\ sent' = Tail(sent)
    /\ UNCHANGED <<disk, mtime, touchesLeft, extLeft, drainsLeft, touch, touchVer,
                   touchBase, touchAt, pending, drain, pair, snap, delivered>>

CancelSuperseded ==
    /\ AllowCancel /\ Len(sent) > 1
    /\ sent' = Tail(sent)
    /\ UNCHANGED <<clock, disk, mtime, touchesLeft, extLeft, drainsLeft, touch,
                   touchVer, touchBase, touchAt, pubCount, cache, pending, drain, pair, snap, delivered>>

-----------------------------------------------------------------------------
\* rearmPendingAuxiliaryCoverage; past the ceiling the pair drops.
Rearm(p, refresh) ==
    pending' = IF p.rearms >= MaxRearms THEN None
               ELSE IF refresh
                 THEN [marked |-> clock + 1, rearms |-> p.rearms + 1,
                       need |-> Len(sent), seq |-> pubCount]
                 ELSE [p EXCEPT !.rearms = p.rearms + 1]

DrainStart ==
    /\ drain = "idle" /\ touch = "idle" /\ drainsLeft > 0 /\ pending /= None
    /\ drainsLeft' = drainsLeft - 1
    /\ pair' = pending /\ pending' = None /\ drain' = "read"
    /\ UNCHANGED <<clock, disk, mtime, touchesLeft, extLeft, touch, touchVer,
                   touchBase, touchAt, sent, pubCount, cache, snap, delivered>>

\* readCachedDiagnosticsForServers resolves with the cached entry, then the
\* synchronous freshness check.
DrainRead ==
    /\ drain = "read"
    /\ snap' = cache
    /\ LET waitIt == \/ cache = None
                     \/ PublishedAtCheck /\ cache.ts <= pair.marked
                     \/ CountBind /\ pubCount - pair.seq < pair.need
       IN IF waitIt
            THEN /\ Rearm(pair, FALSE) /\ drain' = "idle"
            ELSE /\ drain' = "observe" /\ UNCHANGED pending
    /\ UNCHANGED <<clock, disk, mtime, touchesLeft, extLeft, drainsLeft, touch,
                   touchVer, touchBase, touchAt, sent, pubCount, cache, pair, delivered>>

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
                   touchBase, touchAt, sent, pubCount, cache, pair, snap>>

Next == AgentTouch \/ GraceEnd \/ ExternalEdit \/ Publish \/ CancelSuperseded
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
