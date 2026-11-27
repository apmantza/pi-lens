-------------------------- MODULE CascadeDelivery --------------------------
(***************************************************************************
What the cascade tells the agent about the import neighbours of an edited
file, turn after turn (#4485, #4486, #4487): the in-lane compute
(clients/dispatch/integration.ts computeCascadeForFile), the outstanding
silent-push touches (clients/lsp/cascade-tier.ts), and the turn_end
render (clients/runtime-turn.ts handleTurnEnd) with the pending error
record (clients/cascade-format.ts).

One primary, a fixed set of neighbours, one cascade run per turn. Each
neighbour's server follows one publish model, chosen at Init from Models:
 - "Pull":    answers a request at once (pull diagnostics);
 - "CmdPull": push-only, but answers the typescript.tsserverRequest command
              (classic TypeScript); publishes only when its verdict changes
              or on a first open;
 - "Always":  publishes after every notify (pyright);
 - "Silent":  push-only with no command (lua); publishes only on a change
              or a first open, so silence can mean clean or "not yet".

Freshness is an epoch, not a clock: `epoch` counts the primary's edits, and
a cache entry stamped with the current epoch was published after the edit
the run is about (integration.ts `isPostEditObservation`, `ts > cascadeStart`).

Actions:
 - Edit: the primary's write and notify. Every neighbour's verdict may flip;
   an open neighbour owes a publish per its model.
 - Publish(n): an owed publish arrives (the client's per-file cache).
 - Compute: the run for this turn's write, every neighbour at once: the
   recently-clean skip, the passive snapshot, the touch per model and tier,
   the bounded in-lane wait, the degraded fallback, the delta.
 - LaterWrite: the primary is rewritten before turn_end, so the run is
   superseded and renders nothing (runtime-turn.ts `getFilesChangedSince`).
 - QuietWindow: optional; reconciles answered outstanding touches.
 - Expire(n): an outstanding touch ages out of the registry.
 - OutsideChange(n, k): the neighbour's file is written by something pi
   never saw (git checkout, an external editor or formatter; k = "write",
   whether or not its verdict flips) or deleted (k = "delete"), either
   between turns or between the compute's read and turn_end (#4495 round 3).
   The client's cached publish now predates the change.
 - PiWrite(n, a): pi itself writes the neighbour after the run's read
   (#5804). a = "answered": a language server reached a verdict on the
   write, so the write's own dispatch reports what is left; a =
   "unanswered": none did (inconclusive, crashed, timed out, superseded,
   never dispatched).
 - TurnEnd: settle, peek the registry, render the run, the late answers,
   the unresolved and changed lines, and update the record.

Invariants:
 - NoCleanWithoutFreshObs: a neighbour of a delivered run the agent reads
   as clean (no error, no pending, no unresolved line) was observed clean
   after the edit.
 - NoErrWithoutFreshObs: an error shown as this turn's was observed after
   the edit.
 - PersistentReserved: an error the record holds, that no observation
   after the edit read clean, is shown again (as this turn's error, as a
   late answer, or as an unresolved line).
 - TouchEndsWithinBound: every touch the run sent ends answered or shown
   pending in the same turn.
 - AnswerWhenAskable: a neighbour whose server answers on request is
   answered, never left outstanding.
 - ExpiryKeepsAnswer: no answer that arrived for an outstanding touch is
   dropped unread when the touch expires.
 - NoUnresolvedAfterChange: the unresolved line never names a neighbour
   whose file changed after the observation its record holds (#4495 F1,
   round-2 verify R2-1).
 - NoSilentForget: a recorded error whose file was written outside pi is
   never forgotten without the "changed since checked" line (#4495 round-2
   verify R2-2); a deleted file's record may go silently.
 - NoForgetAfterUnansweredWrite: a neighbour error the model knows (held by
   the record, or observed this turn) is never forgotten after pi wrote the
   file with no language-server answer, unless a newer observation read it
   clean (#5804). The write is pi's own, so the "changed outside pi" line
   does not excuse the drop: the error may still be on disk.
 - TypeOK.
***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS
    Neighbours,         \* the import neighbours of the primary
    Models,             \* publish models the scenario allows (subset of the four)
    MaxTurns,           \* turns explored
    Expiry,             \* turns before an outstanding touch expires
    QuietFires,         \* the quiet window may run (it may also never run)
    TierPath,           \* "inLane"     CmdPull neighbours take the waits path (#707 sync confirm)
                        \*              and Silent ones a bounded wait (integration.ts
                        \*              SILENT_PUSH_WAIT_MS; cascade-tier.ts "command-pull")
                        \* "deferQuiet" tier-3 neighbours are touched and deferred to the
                        \*              quiet window (pre-#4485)
    PassiveGate,        \* "afterEdit"  a passive snapshot serves only if published after
                        \*              the cascade started (isPostEditObservation)
                        \* "ttl"        any snapshot younger than the TTL serves (pre-#4486)
    FallbackGate,       \* "afterEdit"  the touch-error and degraded fallbacks display only
                        \*              post-edit entries
                        \* "ttl"        they display any entry younger than the TTL
    RecentlyClean,      \* TRUE: a neighbour confirmed clean is skipped by later runs
                        \* (the recently-clean cache, pre-#4485)
    Delta,              \* "none"    every observed error is listed on every run
                        \* "rolling" an error listed on the previous run is hidden (pre-#4487)
    UnconfirmedMarker,  \* "marked" an unanswered neighbour is named on a pending line
                        \*          (CascadeRun.unconfirmed, the turn_end advisory)
                        \* "none"   it is dropped and the run can read clean
    ExpiryRead,         \* "peekLog" turn_end peeks the registry and an expiring touch
                        \*           is read before it is dropped (cascade-tier.ts
                        \*           peekOutstandingCascadeTouches, deliverResolvedOutcome)
                        \* "drop"    no peek; expiry drops the touch unread
    Reserve,            \* "record" a delivered error stays pending until observed
                        \*          clean, and turn_end renders it when not re-checked
                        \* "none"   no record (pre-#4487)
    PendingGate,        \* "notify" turn_end passes each record entry through the
                        \*          freshness gate against its read bound
                        \*          (runtime-turn.ts `pendingGate`); a written
                        \*          neighbour is named once "changed since checked"
                        \*          and forgotten, a deleted one forgotten silently
                        \* "drop"   both are forgotten silently (#4495 round 2)
                        \* "none"   the record renders whatever happened to the file
                        \*          (#4495 round 1)
    OutsidePhases,      \* when OutsideChange may fire: a subset of {"start"} (between
                        \* turns) and {"computed"} (between the compute's read and
                        \* turn_end); a config bound, not a fix switch
    OutsideKinds,       \* which outside changes: a subset of {"write", "delete"}
    CheckStamp,         \* "read"     the record's stamp is the run's read bound
                        \*            (CascadeRun.checkedAt: the compute's start,
                        \*            or a late answer's touchedAt), so the gate
                        \*            sees any write after the read, pi's own
                        \*            included
                        \* "delivery" the stamp is turn_end's delivery time
                        \*            (#4495 round 2), so a write between the
                        \*            read and turn_end is invisible to the gate
                        \* "carry"    the read bound, and a record kept after pi's
                        \*            unanswered write is restamped to turn_end
                        \*            (cascade-format.ts
                        \*            settleCascadePendingAfterWrite, #5804), so
                        \*            the gate reads that write as carried, not as
                        \*            an edit outside pi
    WriteSettle,        \* "answered" turn_end forgets a pi-written neighbour's record
                        \*            only when a language server answered for the
                        \*            write (the write's own dispatch reports the
                        \*            rest); an unanswered write keeps it (#5804)
                        \* "forget"   it forgets the record of every pi-written
                        \*            neighbour, answered or not (before #5804)
    PiWriteAnswers      \* which pi writes of a neighbour the scenario allows: a
                        \* subset of {"answered", "unanswered"}; {} turns PiWrite
                        \* off. A config bound, not a fix switch

VARIABLES
    turn,       \* 1..MaxTurns + 1
    phase,      \* "start" | "edited" | "computed"
    model,      \* [Neighbours -> Models], fixed after Init
    opened,     \* [Neighbours -> BOOLEAN] the server has the file open
    truth,      \* [Neighbours -> {"clean", "err"}] the server's current verdict
    epoch,      \* edits so far
    cache,      \* [Neighbours -> [val, ep]] the client's last publish per file
    owed,       \* [Neighbours -> BOOLEAN] the server owes a publish
    reg,        \* [Neighbours -> 0..MaxTurns] the outstanding touch's turn, 0 = none
    answered,   \* [Neighbours -> BOOLEAN] a publish arrived since the outstanding touch
    rc,         \* [Neighbours -> BOOLEAN] the recently-clean cache (as-built)
    lastErr,    \* [Neighbours -> BOOLEAN] the delta baseline: listed on the last run
    verdict,    \* [Neighbours -> outcome of this turn's run]
    fresh,      \* [Neighbours -> BOOLEAN] the run's observation is post-edit
    vep,        \* [Neighbours -> 0..MaxTurns] the epoch of the run's observation
    display,    \* [Neighbours -> SUBSET {"err", "pending"}] what the run renders
    touched,    \* [Neighbours -> BOOLEAN] the run sent a touch
    superseded, \* this turn's run was superseded
    lateQ,      \* neighbours whose late answer turn_end delivers
    rec,        \* [Neighbours -> Rec] the last delivered observation and its epoch
    shown,      \* [Neighbours -> SUBSET Tags] this turn's render
    recBefore,  \* rec at the start of this TurnEnd
    freshClean, \* [Neighbours -> BOOLEAN] observed clean after the edit this turn
    freshErr,   \* [Neighbours -> BOOLEAN] observed err after the edit this turn
    lost,       \* an answered touch expired unread
    cacheChg,   \* [Neighbours -> Kinds] the cached publish predates an outside change
    vchg,       \* [Neighbours -> Kinds] this turn's observation predates an outside change
    vmid,       \* [Neighbours -> BOOLEAN] that change landed after this turn's read
    chg,        \* [Neighbours -> Kinds] the file changed after the observation rec holds
    chgSeen,    \* [Neighbours -> Kinds] that change as the freshness gate can see it
    staleClaim, \* some turn_end named a changed neighbour on the unresolved line
    silentDrop, \* some turn_end forgot a written neighbour's errors without a line
    pw,         \* [Neighbours -> PiWrites] pi wrote the neighbour this turn, after the read
    pq,         \* [Neighbours -> PiWrites] such a write of an earlier turn that is still on
                \* the turn's worklist (turn state outlives a turn_end that delivered a blocker)
    wr,         \* [Neighbours -> BOOLEAN] the record holds errors of a file pi wrote with no answer
    piDrop      \* some turn_end forgot such an error with no newer clean observation

vars == <<turn, phase, model, opened, truth, epoch, cache, owed, reg, answered,
          rc, lastErr, verdict, fresh, vep, display, touched, superseded, lateQ,
          rec, shown, recBefore, freshClean, freshErr, lost, cacheChg, vchg, vmid,
          chg, chgSeen, staleClaim, silentDrop, pw, pq, wr, piDrop>>

Vals == {"clean", "err"}
Tags == {"err", "pending", "late", "unresolved", "changed", "own"}
PiWrites == {"none", "answered", "unanswered"}
Kinds == {"none", "write", "delete"}
Outcomes == {"none", "clean", "err", "unconfirmed", "deferred", "inconclusive"}
Entry == [val : {"none", "clean", "err"}, ep : 0..MaxTurns]
Rec == [val : {"none", "err"}, ep : 0..MaxTurns]
NoRec == [val |-> "none", ep |-> 0]

TypeOK ==
    /\ turn \in 1..(MaxTurns + 1)
    /\ phase \in {"start", "edited", "computed"}
    /\ model \in [Neighbours -> Models]
    /\ opened \in [Neighbours -> BOOLEAN]
    /\ truth \in [Neighbours -> Vals]
    /\ epoch \in 0..MaxTurns
    /\ cache \in [Neighbours -> Entry]
    /\ owed \in [Neighbours -> BOOLEAN]
    /\ reg \in [Neighbours -> 0..MaxTurns]
    /\ answered \in [Neighbours -> BOOLEAN]
    /\ rc \in [Neighbours -> BOOLEAN]
    /\ lastErr \in [Neighbours -> BOOLEAN]
    /\ verdict \in [Neighbours -> Outcomes]
    /\ fresh \in [Neighbours -> BOOLEAN]
    /\ vep \in [Neighbours -> 0..MaxTurns]
    /\ display \in [Neighbours -> SUBSET {"err", "pending"}]
    /\ touched \in [Neighbours -> BOOLEAN]
    /\ superseded \in BOOLEAN
    /\ lateQ \subseteq Neighbours
    /\ rec \in [Neighbours -> Rec]
    /\ shown \in [Neighbours -> SUBSET Tags]
    /\ recBefore \in [Neighbours -> Rec]
    /\ freshClean \in [Neighbours -> BOOLEAN]
    /\ freshErr \in [Neighbours -> BOOLEAN]
    /\ lost \in BOOLEAN
    /\ cacheChg \in [Neighbours -> Kinds]
    /\ vchg \in [Neighbours -> Kinds]
    /\ vmid \in [Neighbours -> BOOLEAN]
    /\ chg \in [Neighbours -> Kinds]
    /\ chgSeen \in [Neighbours -> Kinds]
    /\ staleClaim \in BOOLEAN
    /\ silentDrop \in BOOLEAN
    /\ pw \in [Neighbours -> PiWrites]
    /\ pq \in [Neighbours -> PiWrites]
    /\ wr \in [Neighbours -> BOOLEAN]
    /\ piDrop \in BOOLEAN

\* Warm start: an open neighbour holds a publish of its starting verdict.
Init ==
    /\ turn = 1
    /\ phase = "start"
    /\ model \in [Neighbours -> Models]
    /\ opened \in [Neighbours -> BOOLEAN]
    /\ truth \in [Neighbours -> Vals]
    /\ epoch = 0
    /\ cache = [n \in Neighbours |->
                  IF opened[n] THEN [val |-> truth[n], ep |-> 0]
                  ELSE [val |-> "none", ep |-> 0]]
    /\ owed = [n \in Neighbours |-> FALSE]
    /\ reg = [n \in Neighbours |-> 0]
    /\ answered = [n \in Neighbours |-> FALSE]
    /\ rc = [n \in Neighbours |-> FALSE]
    /\ lastErr = [n \in Neighbours |-> FALSE]
    /\ verdict = [n \in Neighbours |-> "none"]
    /\ fresh = [n \in Neighbours |-> FALSE]
    /\ vep = [n \in Neighbours |-> 0]
    /\ display = [n \in Neighbours |-> {}]
    /\ touched = [n \in Neighbours |-> FALSE]
    /\ superseded = FALSE
    /\ lateQ = {}
    /\ rec = [n \in Neighbours |-> NoRec]
    /\ shown = [n \in Neighbours |-> {}]
    /\ recBefore = [n \in Neighbours |-> NoRec]
    /\ freshClean = [n \in Neighbours |-> FALSE]
    /\ freshErr = [n \in Neighbours |-> FALSE]
    /\ lost = FALSE
    /\ cacheChg = [n \in Neighbours |-> "none"]
    /\ vchg = [n \in Neighbours |-> "none"]
    /\ vmid = [n \in Neighbours |-> FALSE]
    /\ chg = [n \in Neighbours |-> "none"]
    /\ chgSeen = [n \in Neighbours |-> "none"]
    /\ staleClaim = FALSE
    /\ silentDrop = FALSE
    /\ pw = [n \in Neighbours |-> "none"]
    /\ pq = [n \in Neighbours |-> "none"]
    /\ wr = [n \in Neighbours |-> FALSE]
    /\ piDrop = FALSE

\* A push server's publish rule: Always after every notify; CmdPull and
\* Silent only on a change of verdict (classic tsserver, probe S0-S4).
PushOwes(n, t) ==
    \/ model[n] = "Always"
    /\ model[n] \in {"CmdPull", "Silent"} /\ t[n] # cache[n].val

\* Edit: the primary's write and notify (runtime-tool-result.ts dispatch).
Edit ==
    /\ phase = "start"
    /\ turn <= MaxTurns
    /\ \E t \in [Neighbours -> Vals]:
        /\ truth' = t
        /\ owed' = [n \in Neighbours |->
                      owed[n] \/ (opened[n] /\ PushOwes(n, t))]
    /\ epoch' = epoch + 1
    /\ phase' = "edited"
    /\ UNCHANGED <<turn, model, opened, cache, reg, answered, rc, lastErr,
                   verdict, fresh, vep, display, touched, superseded, lateQ, rec,
                   shown, recBefore, freshClean, freshErr, lost, cacheChg, vchg, vmid,
                   chg, chgSeen, staleClaim, silentDrop, pw, pq, wr, piDrop>>

\* Publish(n): the owed publish lands in the client's per-file cache
\* (client.ts publishDiagnostics handling). A touch outstanding in the
\* registry is now answered.
Publish(n) ==
    /\ owed[n]
    /\ owed' = [owed EXCEPT ![n] = FALSE]
    /\ cache' = [cache EXCEPT ![n] = [val |-> truth[n], ep |-> epoch]]
    /\ answered' = [answered EXCEPT ![n] = reg[n] # 0 \/ answered[n]]
    /\ cacheChg' = [cacheChg EXCEPT ![n] = "none"]
    /\ UNCHANGED <<turn, phase, model, opened, truth, epoch, reg, rc, lastErr,
                   verdict, fresh, vep, display, touched, superseded, lateQ, rec,
                   shown, recBefore, freshClean, freshErr, lost, vchg, vmid, chg,
                   chgSeen, staleClaim, silentDrop, pw, pq, wr, piDrop>>

PostEdit(n) == cache[n].ep = epoch
PassiveServes(n) ==
    /\ cache[n].val # "none"
    /\ PassiveGate = "ttl" \/ PostEdit(n)

\* The per-neighbour outcome of one compute. `arrive[n]` is the bounded
\* wait's nondeterminism: the owed publish lands inside the wait or not.
\* Returns [v, f, e, t, o, r, c]: verdict, fresh, the observation's epoch,
\* touched, owed after, registry entry, cache after.
Step(n, arrive) ==
    LET answer == [v |-> truth[n], f |-> TRUE, e |-> epoch, t |-> TRUE, o |-> FALSE,
                   r |-> 0, c |-> [val |-> truth[n], ep |-> epoch]]
        \* the touch opens the file; a silent-push server publishes on a
        \* change or a first open (probe S3/S3b)
        owesNow == owed[n] \/ ~opened[n] \/ truth[n] # cache[n].val
        waitOut(o) == IF o /\ arrive[n] THEN answer
                      ELSE [v |-> "unconfirmed", f |-> FALSE, e |-> 0, t |-> TRUE,
                            o |-> o, r |-> turn, c |-> cache[n]]
        defer(o) == [v |-> "deferred", f |-> FALSE, e |-> 0, t |-> TRUE, o |-> o,
                     r |-> turn, c |-> cache[n]]
    IN
    IF RecentlyClean /\ rc[n]
        \* integration.ts recentlyClean skip (deleted by #4485)
        THEN [v |-> "clean", f |-> FALSE, e |-> 0, t |-> FALSE, o |-> owed[n],
              r |-> reg[n], c |-> cache[n]]
    ELSE IF PassiveServes(n)
        \* integration.ts passive snapshot (`allDiags`)
        THEN [v |-> cache[n].val, f |-> PostEdit(n), e |-> cache[n].ep, t |-> FALSE,
              o |-> owed[n], r |-> reg[n], c |-> cache[n]]
    ELSE IF model[n] = "Pull" THEN answer
    \* the waits path (unchanged by #4485): a touch the wait gives up on is
    \* inconclusive and renders its own line (cascade-format.ts)
    ELSE IF model[n] = "Always"
        THEN IF arrive[n] THEN answer
             ELSE [v |-> "inconclusive", f |-> FALSE, e |-> 0, t |-> TRUE, o |-> TRUE,
                   r |-> reg[n], c |-> cache[n]]
    ELSE IF model[n] = "CmdPull"
        THEN IF TierPath = "inLane" THEN answer ELSE defer(owesNow)
    ELSE IF TierPath = "inLane" THEN waitOut(owesNow) ELSE defer(owesNow)

\* Compute: computeCascadeForFile for this turn's write.
Compute ==
    /\ phase = "edited"
    /\ \E arrive \in [Neighbours -> BOOLEAN]:
        LET s == [n \in Neighbours |-> Step(n, arrive)]
            unanswered(n) == s[n].v \in {"unconfirmed", "deferred"}
            \* the touch-error and degraded fallbacks show a cached error
            fallbackErr(n) ==
                /\ unanswered(n)
                /\ s[n].c.val = "err"
                /\ FallbackGate = "ttl" \/ s[n].c.ep = epoch
            listed(n) == s[n].v = "err" /\ ~(Delta = "rolling" /\ lastErr[n])
        IN
        /\ verdict' = [n \in Neighbours |-> s[n].v]
        /\ fresh' = [n \in Neighbours |-> s[n].f]
        /\ vep' = [n \in Neighbours |-> s[n].e]
        /\ touched' = [n \in Neighbours |-> s[n].t]
        /\ owed' = [n \in Neighbours |-> s[n].o]
        /\ reg' = [n \in Neighbours |-> s[n].r]
        /\ answered' = [n \in Neighbours |->
                          IF s[n].r = turn THEN FALSE ELSE answered[n]]
        /\ cache' = [n \in Neighbours |-> s[n].c]
        /\ opened' = [n \in Neighbours |-> opened[n] \/ s[n].t]
        /\ display' = [n \in Neighbours |->
                         (IF listed(n) \/ fallbackErr(n) THEN {"err"} ELSE {})
                         \cup (IF (unanswered(n) /\ UnconfirmedMarker = "marked")
                                  \/ s[n].v = "inconclusive"
                               THEN {"pending"} ELSE {})]
        /\ freshErr' = [n \in Neighbours |->
                          (s[n].v = "err" /\ s[n].f)
                          \/ (fallbackErr(n) /\ s[n].c.ep = epoch)]
        /\ freshClean' = [n \in Neighbours |-> s[n].v = "clean" /\ s[n].f]
        /\ rc' = [n \in Neighbours |->
                    s[n].v = "clean" \/ (rc[n] /\ s[n].v # "err")]
        /\ lastErr' = [n \in Neighbours |-> s[n].v = "err"]
        \* A touch answered with a new publish observes the file as it is
        \* now; a passive snapshot is as old as the publish it came from.
        /\ vchg' = [n \in Neighbours |->
                      IF s[n].t /\ s[n].v \in {"clean", "err"} THEN "none"
                      ELSE cacheChg[n]]
        /\ cacheChg' = [n \in Neighbours |->
                          IF s[n].c # cache[n] THEN "none" ELSE cacheChg[n]]
    /\ vmid' = [n \in Neighbours |-> FALSE]
    /\ superseded' = FALSE
    /\ phase' = "computed"
    /\ UNCHANGED <<turn, model, truth, epoch, lateQ, rec, shown, recBefore,
                   lost, chg, chgSeen, staleClaim, silentDrop, pw, pq, wr, piDrop>>

\* LaterWrite: a later write of the primary supersedes the run before
\* turn_end (runtime-turn.ts consume filter, `cascade_carry_over_drop`).
LaterWrite ==
    /\ phase = "edited"
    /\ superseded' = TRUE
    /\ verdict' = [n \in Neighbours |-> "none"]
    /\ fresh' = [n \in Neighbours |-> FALSE]
    /\ vep' = [n \in Neighbours |-> 0]
    /\ touched' = [n \in Neighbours |-> FALSE]
    /\ display' = [n \in Neighbours |-> {}]
    /\ freshErr' = [n \in Neighbours |-> FALSE]
    /\ freshClean' = [n \in Neighbours |-> FALSE]
    /\ phase' = "computed"
    /\ vchg' = [n \in Neighbours |-> "none"]
    /\ vmid' = [n \in Neighbours |-> FALSE]
    /\ UNCHANGED <<turn, model, opened, truth, epoch, cache, owed, reg,
                   answered, rc, lastErr, lateQ, rec, shown, recBefore, lost,
                   cacheChg, chg, chgSeen, staleClaim, silentDrop, pw, pq, wr, piDrop>>

\* QuietWindow: quiet-window.ts reconciles answered outstanding touches
\* (cascade-tier.ts reconcileOutstandingCascadeTouches); the answer reaches
\* the next turn_end as a cascade run.
QuietWindow ==
    /\ QuietFires
    /\ \E n \in Neighbours:
        /\ reg[n] # 0 /\ answered[n]
        /\ reg' = [reg EXCEPT ![n] = 0]
        /\ answered' = [answered EXCEPT ![n] = FALSE]
        /\ lateQ' = lateQ \cup {n}
    /\ UNCHANGED <<turn, phase, model, opened, truth, epoch, cache, owed, rc,
                   lastErr, verdict, fresh, vep, display, touched, superseded, rec,
                   shown, recBefore, freshClean, freshErr, lost, cacheChg, vchg,
                   vmid, chg, chgSeen, staleClaim, silentDrop, pw, pq, wr, piDrop>>

\* Expire(n): cascade-tier.ts prune of an outstanding touch past its
\* maximum age.
Expire(n) ==
    /\ reg[n] # 0
    /\ turn - reg[n] >= Expiry
    /\ reg' = [reg EXCEPT ![n] = 0]
    /\ answered' = [answered EXCEPT ![n] = FALSE]
    /\ IF ExpiryRead = "peekLog"
          THEN /\ lateQ' = IF answered[n] THEN lateQ \cup {n} ELSE lateQ
               /\ UNCHANGED lost
          ELSE /\ lost' = (lost \/ answered[n])
               /\ UNCHANGED lateQ
    /\ UNCHANGED <<turn, phase, model, opened, truth, epoch, cache, owed, rc,
                   lastErr, verdict, fresh, vep, display, touched, superseded, rec,
                   shown, recBefore, freshClean, freshErr, cacheChg, vchg, vmid,
                   chg, chgSeen, staleClaim, silentDrop, pw, pq, wr, piDrop>>

\* OutsideChange(n, k): the file is written (k = "write") by something pi
\* never saw, or deleted (k = "delete"). It lands between turns (phase
\* "start") or between the compute's read and turn_end (phase "computed",
\* #4495 round-2 verify R2-1). The server is not notified, so nothing is owed;
\* the cached publish now predates the change, and so does the observation
\* the record holds, and in phase "computed" the observation this turn's run
\* made. A write after the record's delivery is visible to the gate under
\* either stamp. One change per cached publish keeps the state space finite;
\* a second change before the next publish is the same state.
OutsideChange(n, k) ==
    /\ phase \in OutsidePhases
    /\ turn <= MaxTurns
    /\ cacheChg[n] = "none"
    /\ \E v \in Vals: truth' = [truth EXCEPT ![n] = v]
    /\ cacheChg' = [cacheChg EXCEPT ![n] = k]
    /\ chg' = [chg EXCEPT ![n] = IF rec[n].val = "err" THEN k ELSE "none"]
    /\ chgSeen' = [chgSeen EXCEPT ![n] = IF rec[n].val = "err" THEN k ELSE "none"]
    /\ IF phase = "computed" /\ verdict[n] \in {"clean", "err"}
          THEN /\ vchg' = [vchg EXCEPT ![n] = k]
               /\ vmid' = [vmid EXCEPT ![n] = TRUE]
          ELSE UNCHANGED <<vchg, vmid>>
    /\ UNCHANGED <<turn, phase, model, opened, epoch, cache, owed, reg, answered,
                   rc, lastErr, verdict, fresh, vep, display, touched, superseded,
                   lateQ, rec, shown, recBefore, freshClean, freshErr, lost,
                   staleClaim, silentDrop, pw, pq, wr, piDrop>>

\* PiWrite(n, a): pi itself writes the neighbour after this turn's run read
\* it (#5804). The write is the agent's own, not an outside change: it
\* sets neither `chg` nor `cacheChg`. `a` is whether a language server
\* reached a verdict on it (the write's dispatch listed `lsp` in its
\* verdictRunnerIds, cascade-format.ts noteCascadeWrite). The write
\* happens once per neighbour per turn; the model keeps its final answer.
PiWrite(n, a) ==
    /\ phase = "computed"
    /\ turn <= MaxTurns
    /\ a \in PiWriteAnswers
    /\ pw' = [pw EXCEPT ![n] = a]
    /\ UNCHANGED <<turn, phase, model, opened, truth, epoch, cache, owed, reg,
                   answered, rc, lastErr, verdict, fresh, vep, display, touched,
                   superseded, lateQ, rec, shown, recBefore, freshClean, freshErr,
                   lost, cacheChg, vchg, vmid, chg, chgSeen, staleClaim,
                   silentDrop, pq, wr, piDrop>>

\* TurnEnd: runtime-turn.ts handleTurnEnd. The registry peek
\* (peekOutstandingCascadeTouches) moves answered touches to the late queue;
\* the run's display, the late answers and the unresolved line render; the
\* record takes what was delivered (recordDeliveredCascadeNeighbor,
\* forgetCascadePendingNeighbor).
TurnEnd ==
    /\ phase = "computed"
    /\ LET peeked == IF ExpiryRead = "peekLog"
                     THEN {n \in Neighbours : reg[n] # 0 /\ answered[n]}
                     ELSE {}
           late == lateQ \cup peeked
           lateErr(n) == n \in late /\ cache[n].val = "err"
           lateClean(n) == n \in late /\ cache[n].val = "clean"
           \* an answer from before this turn's edit is labelled late, not
           \* this turn's (the carried-run label)
           lateFresh(n) == n \in late /\ cache[n].ep = epoch
           observed(n) == verdict[n] \in {"clean", "err"} \/ n \in late
           \* The settle at the top of handleTurnEnd (settleCascadePendingAfterWrite):
           \* a pi-written neighbour whose write a server answered (or, before
           \* #5804, any pi-written one) loses its record, and this turn's
           \* observations of it are not recorded (`editedKeys`).
           \* the write the settle sees: this turn's, else one still on the
           \* worklist from a turn_end that delivered a blocker
           eff(n) == IF pw[n] # "none" THEN pw[n] ELSE pq[n]
           settled(n) == eff(n) # "none"
                         /\ (eff(n) = "answered" \/ WriteSettle = "forget")
           pending(n) == Reserve = "record" /\ ~settled(n) /\ rec[n].val = "err"
                         /\ ~observed(n)
           \* What the gate can see of a write to the file after the record's
           \* stamp. pi's unanswered write comes after the run's read: the
           \* read-bound stamp shows it as a change; the restamp moved the
           \* kept record's stamp to turn_end, so it reads as carried.
           seen(n) == IF eff(n) = "unanswered" /\ CheckStamp = "read" THEN "write"
                      ELSE IF eff(n) = "unanswered" /\ CheckStamp = "carry" THEN "none"
                      ELSE chgSeen[n]
           \* the freshness gate: an entry whose file changed after its
           \* read bound, as far as the stamp lets the gate see, is gated out
           gatedOut(n) == PendingGate \in {"notify", "drop"} /\ seen(n) # "none"
           changedLine(n) == PendingGate = "notify" /\ pending(n)
                             /\ seen(n) = "write"
           unresolved(n) == pending(n) /\ ~gatedOut(n)
           \* a clean observation newer than the record's error
           cleanedBy(n) == (verdict[n] = "clean" /\ vep[n] > rec[n].ep)
                           \/ (lateClean(n) /\ cache[n].ep > rec[n].ep)
           \* the record's errors are unconfirmed since a pi write no server answered
           \* (a later answered write speaks for the file and ends it)
           unconf(n) == eff(n) = "unanswered" \/ (wr[n] /\ eff(n) = "none")
       IN
       /\ shown' = [n \in Neighbours |->
                      display[n]
                      \cup (IF lateErr(n) /\ lateFresh(n) THEN {"err"} ELSE {})
                      \cup (IF lateErr(n) /\ ~lateFresh(n) THEN {"late"} ELSE {})
                      \cup (IF unresolved(n) THEN {"unresolved"} ELSE {})
                      \cup (IF changedLine(n) THEN {"changed"} ELSE {})
                      \* an answered write's own dispatch reported the file
                      \cup (IF eff(n) = "answered" THEN {"own"} ELSE {})]
       /\ freshErr' = [n \in Neighbours |->
                         freshErr[n] \/ (lateErr(n) /\ lateFresh(n))]
       /\ freshClean' = [n \in Neighbours |->
                           freshClean[n] \/ (lateClean(n) /\ lateFresh(n))]
       /\ recBefore' = rec
       \* The record is the last delivered observation, kept whatever
       \* Reserve says (Reserve only decides whether turn_end renders it).
       \* A clean observation clears it only when newer than the error it
       \* holds (forgetCascadePendingNeighbor's `observedAt` check).
       /\ rec' = [n \in Neighbours |->
                    IF settled(n) THEN NoRec
                    ELSE IF verdict[n] = "err" THEN [val |-> "err", ep |-> vep[n]]
                    ELSE IF lateErr(n) THEN [val |-> "err", ep |-> cache[n].ep]
                    ELSE IF verdict[n] = "clean" /\ vep[n] > rec[n].ep THEN NoRec
                    ELSE IF lateClean(n) /\ cache[n].ep > rec[n].ep THEN NoRec
                    ELSE IF ~observed(n) /\ gatedOut(n) THEN NoRec
                    ELSE rec[n]]
       /\ staleClaim' = (staleClaim \/ (\E n \in Neighbours: unresolved(n) /\ chg[n] # "none"))
       /\ silentDrop' = (silentDrop \/ (\E n \in Neighbours:
                            pending(n) /\ gatedOut(n) /\ chg[n] = "write"
                            /\ ~changedLine(n)))
       \* the drop #5804 forbids: an error the model knows, forgotten with no
       \* newer clean observation, while a pi write no server answered is
       \* the last word on the file's bytes
       /\ piDrop' = (piDrop \/ (\E n \in Neighbours:
                         unconf(n) /\ rec'[n].val = "none" /\ ~cleanedBy(n)
                         /\ (rec[n].val = "err" \/ verdict[n] = "err"
                             \/ lateErr(n))))
       /\ wr' = [n \in Neighbours |->
                    IF rec'[n].val = "none" THEN FALSE
                    ELSE IF verdict[n] = "err" \/ lateErr(n) THEN pw[n] = "unanswered"
                    ELSE unconf(n)]
       \* the worklist keeps a write while this turn_end delivered a blocker;
       \* a turn_end with none clears it (turn state, runtime-turn.ts)
       /\ pw' = [n \in Neighbours |-> "none"]
       /\ pq' = [n \in Neighbours |->
                    IF \E m \in Neighbours:
                          shown'[m] \cap {"err", "late", "unresolved", "changed", "pending"} # {}
                    THEN eff(n) ELSE "none"]
       \* whether the observation the record now holds predates a change
       /\ chg' = [n \in Neighbours |->
                    IF settled(n) THEN "none"
                    ELSE IF verdict[n] = "err" THEN vchg[n]
                    ELSE IF lateErr(n) THEN cacheChg[n]
                    ELSE IF rec'[n].val = "none" THEN "none"
                    ELSE chg[n]]
       \* what the gate can see of it: with the read bound, a change after
       \* this turn's read (vmid) or after a late answer's touch (every
       \* cacheChg of the answered publish); with the delivery stamp,
       \* nothing that landed before this TurnEnd
       /\ chgSeen' = [n \in Neighbours |->
                        IF settled(n) THEN "none"
                        ELSE IF verdict[n] = "err"
                            THEN IF CheckStamp \in {"read", "carry"} /\ vmid[n]
                                 THEN vchg[n]
                                 ELSE IF CheckStamp \in {"read", "carry"}
                                         /\ pw[n] = "unanswered"
                                 THEN "write" ELSE "none"
                        ELSE IF lateErr(n)
                            THEN IF CheckStamp \in {"read", "carry"}
                                 THEN IF cacheChg[n] # "none" THEN cacheChg[n]
                                      ELSE IF pw[n] = "unanswered" THEN "write"
                                      ELSE "none"
                                 ELSE "none"
                        ELSE IF rec'[n].val = "none" THEN "none"
                        ELSE IF eff(n) = "unanswered" /\ CheckStamp = "carry" THEN "none"
                        ELSE chgSeen[n]]
       /\ reg' = [n \in Neighbours |-> IF n \in peeked THEN 0 ELSE reg[n]]
       /\ answered' = [n \in Neighbours |->
                         IF n \in peeked THEN FALSE ELSE answered[n]]
    /\ lateQ' = {}
    /\ turn' = turn + 1
    /\ phase' = "start"
    /\ UNCHANGED <<model, opened, truth, epoch, cache, owed, rc, lastErr,
                   verdict, fresh, vep, display, touched, superseded, lost,
                   cacheChg, vchg, vmid>>

Next ==
    \/ Edit
    \/ \E n \in Neighbours: Publish(n)
    \/ Compute
    \/ LaterWrite
    \/ QuietWindow
    \/ \E n \in Neighbours: Expire(n)
    \/ \E n \in Neighbours, k \in OutsideKinds: OutsideChange(n, k)
    \/ \E n \in Neighbours, a \in PiWriteAnswers: PiWrite(n, a)
    \/ TurnEnd

Spec == Init /\ [][Next]_vars

\* The invariants read the state right after a TurnEnd (phase "start",
\* turn > 1): `shown` is that turn's render.
AfterTurnEnd == phase = "start" /\ turn > 1

AgentReadsClean(n) == shown[n] = {}

NoCleanWithoutFreshObs ==
    AfterTurnEnd /\ ~superseded =>
        \A n \in Neighbours: AgentReadsClean(n) => freshClean[n]

NoErrWithoutFreshObs ==
    AfterTurnEnd =>
        \A n \in Neighbours: "err" \in shown[n] => freshErr[n]

PersistentReserved ==
    AfterTurnEnd =>
        \A n \in Neighbours:
            recBefore[n].val = "err" /\ rec[n].val = "err" =>
                shown[n] \cap {"err", "late", "unresolved"} # {}

TouchEndsWithinBound ==
    AfterTurnEnd =>
        \A n \in Neighbours:
            touched[n] => (verdict[n] \in {"clean", "err"} /\ fresh[n])
                          \/ "pending" \in shown[n]

AnswerWhenAskable ==
    AfterTurnEnd =>
        \A n \in Neighbours:
            touched[n] /\ model[n] \in {"Pull", "CmdPull"} =>
                verdict[n] \in {"clean", "err"} /\ fresh[n]

ExpiryKeepsAnswer == ~lost

\* Read at the render itself (staleClaim is set by the TurnEnd that renders
\* the line), not against a later change of a line already delivered.
NoUnresolvedAfterChange == ~staleClaim

\* Read at the render, as above: a written neighbour's record is forgotten
\* only with its "changed since checked" line (the cut-line hold is
\* runtime-turn.ts's, tested in turn-end-cap-consumed-state.test.ts).
NoSilentForget == ~silentDrop

\* Read at the render, as above: a pending error pi's own unanswered write
\* left behind is never forgotten unconfirmed (#5804; cascade-format.ts
\* settleCascadePendingAfterWrite keeps and restamps the record).
NoForgetAfterUnansweredWrite == ~piDrop
=============================================================================
