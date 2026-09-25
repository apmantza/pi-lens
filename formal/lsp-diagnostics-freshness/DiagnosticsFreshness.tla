------------------------- MODULE DiagnosticsFreshness -------------------------
(***************************************************************************)
(* Push-diagnostics freshness for one touch of one open document, between  *)
(* the LSP client (clients/lsp/client.ts) and a push-only server.          *)
(*                                                                         *)
(* Actors:                                                                 *)
(*  - touch A, the pipeline's lsp_sync touch (LSPService.touchFile,        *)
(*    clients/lsp/index.ts). It reads the per-path baseline                *)
(*    (getDiagnosticsVersionForPath, ~4873), then notify.open ->           *)
(*    handleNotifyOpenOnce (client.ts ~4029): the document is open, so it  *)
(*    bumps documentVersions, clears the path's diagnostics and sends      *)
(*    didChange in ONE tick (~4050-4108); markTouched runs after the send  *)
(*    resolves (index.ts ~5173);                                           *)
(*  - the waiter. SkippedWait = FALSE: A itself waits with minVersion =    *)
(*    its baseline (index.ts ~5713). SkippedWait = TRUE: the dispatch      *)
(*    runner's touch B, same content, finds A's markTouched entry          *)
(*    (shouldSkipNotify ~1952), sends nothing, and waits with no baseline  *)
(*    (index.ts ~5727);                                                    *)
(*  - clientWaitForDiagnostics (client.ts ~3797): the early return         *)
(*    (fresh && !isVersionStale && non-empty cache), else a listener whose *)
(*    onDiagnostics re-checks and (re)arms a quiet-window timer that       *)
(*    resolves the wait; a timeout also resolves it. touchFile then reads  *)
(*    getDiagnostics (index.ts ~6583) after further awaits;                *)
(*  - the publishDiagnostics handler (client.ts ~2322-2578): seed-first-   *)
(*    push stores at once, otherwise a per-path debounce timer that checks *)
(*    isSupersededPush when it fires; a clear cancels that timer (~1825);  *)
(*  - the server: reads client messages in order; publishes diagnostics    *)
(*    for the content it last read (or, AsyncServer, for the one before:   *)
(*    an analysis that started before the latest change), stamped with the *)
(*    version iff VersionedServer. Server-to-client messages are FIFO.     *)
(*                                                                         *)
(* Content ghost: the client sends content k as version k, so a publish's  *)
(* `cv` is the content version it was computed for, whether or not the     *)
(* server puts it on the wire (`dv`). The touch's content is version 1.    *)
(***************************************************************************)
EXTENDS Integers, Sequences

CONSTANTS
    VersionedServer, \* TRUE: publishes carry the document version
    SkippedWait,     \* TRUE: the waiter is the skipped dispatch touch (no baseline)
    SeedFirstPush,   \* strategy.seedFirstPush (else the debounce-timer path)
    AsyncServer,     \* TRUE: a publish may be for the content before the last read
    Preserve,        \* resync keeps diagnostics (preserveDiagnostics; not touchFile's own notify)
    Fence,           \* candidate fix: a fence request goes out with the didChange;
                     \* version-less publishes are dropped until its response arrives
    MaxPubs,         \* bound on server publishes
    Mutant           \* "none" or a removed guard, see below

(* Mutant: "none" | "noClear" (handleNotifyOpenOnce skips the clear)       *)
(*   | "noSuperseded" (isSupersededPush always false)                      *)
(*   | "noVersionStale" (isVersionStale always false)                      *)
(*   | "noGuards" (both of the above) | "fenceLate" (the fence is sent and *)
(*   armed after the didChange send resolves, not in the same tick)        *)

NONE == -1          \* "no version": undefined in the code

VARIABLES
    phase,      \* touch A: "start" | "based" | "sent" | "done"
    baseline,   \* A's per-path baseline (diagnosticsVersionForPath)
    cliVer,     \* documentVersions.get(path)
    cache,      \* pushDiagnostics entry: [has, cv (ghost), ne (non-empty)]
    docVerRec,  \* diagnosticDocVersions.get(path), or NONE
    stamp,      \* diagnosticsVersionsByPath.get(path), 0 when absent
    gctr,       \* the client-global diagnosticsVersion counter
    timer,      \* the handler's pending debounce entry: [on, cv, dv, ne]
    fencing,    \* candidate fix: a fence is outstanding
    wire,       \* client -> server messages not yet read
    srvVer,     \* content version the server last read
    srvPrev,    \* the content version before that
    pubs,       \* server -> client messages not yet handled (FIFO)
    npubs,
    w,          \* waiter: "idle" | "listen" | "armed" | "resolved" | "read"
    how,        \* how the wait resolved: "none" | "settled" | "timeout"
    result      \* the cache entry touchFile read: [has, cv, ne]

vars == <<phase, baseline, cliVer, cache, docVerRec, stamp, gctr, timer,
          fencing, wire, srvVer, srvPrev, pubs, npubs, w, how, result>>

Empty == [has |-> FALSE, cv |-> NONE, ne |-> FALSE]
NoTimer == [on |-> FALSE, cv |-> NONE, dv |-> NONE, ne |-> FALSE]

Init ==
    /\ phase = "start"
    /\ baseline = NONE
    /\ cliVer = 0              \* the document is open at version 0 ...
    /\ cache = Empty
    /\ docVerRec = NONE
    /\ stamp = 0
    /\ gctr = 0
    /\ timer = NoTimer
    /\ fencing = FALSE
    /\ wire = << >>
    /\ srvVer = 0              \* ... and the server has read it
    /\ srvPrev = 0
    /\ pubs = << >>
    /\ npubs = 0
    /\ w = "idle"
    /\ how = "none"
    /\ result = Empty

-----------------------------------------------------------------------------
\* Client-side predicates, as the code computes them.

\* isSupersededPush (client.ts ~2479). documentVersions always has the path here.
Superseded(dv) == Mutant \notin {"noSuperseded", "noGuards"} /\ dv # NONE /\ dv < cliVer

\* The waiter's minVersion: A's baseline, or undefined for the skipped touch.
MinV == IF SkippedWait THEN NONE ELSE baseline

\* hasFreshDiagnostics (client.ts ~3813), over a given stamp.
FreshAt(st) == MinV = NONE \/ st > MinV

\* isVersionStale (client.ts ~3826), over a given recorded version.
StaleAt(rec) == Mutant \notin {"noVersionStale", "noGuards"} /\ rec # NONE /\ rec < cliVer

\* clearDiagnosticsForPath (client.ts ~1812): cache, pending timer,
\* diagnosticDocVersions and the per-path stamp.
ClearVars == /\ cache' = Empty
             /\ timer' = NoTimer
             /\ docVerRec' = NONE
             /\ stamp' = 0

\* Store + emit (client.ts ~2560-2574): cache the publish, record its version
\* (only when it carries one), bump the stamp, and run the waiter's
\* onDiagnostics synchronously: it (re)arms the quiet-window timer when fresh
\* and not stale; otherwise it returns and leaves an armed timer armed.
Store(p) ==
    LET rec == IF p.dv # NONE THEN p.dv ELSE docVerRec
        st  == gctr + 1
    IN /\ cache' = [has |-> TRUE, cv |-> p.cv, ne |-> p.ne]
       /\ docVerRec' = rec
       /\ gctr' = st
       /\ stamp' = st
       /\ w' = IF w \in {"listen", "armed"} /\ FreshAt(st) /\ ~StaleAt(rec)
                 THEN "armed" ELSE w

-----------------------------------------------------------------------------
\* Touch A.

\* touchFile reads the per-path baseline before its notify (index.ts ~4870).
Baseline ==
    /\ phase = "start"
    /\ phase' = "based"
    /\ baseline' = stamp
    /\ UNCHANGED <<cliVer, cache, docVerRec, stamp, gctr, timer, fencing, wire,
                   srvVer, srvPrev, pubs, npubs, w, how, result>>

\* The notify-queue runner: handleNotifyOpenOnce's open-document branch bumps
\* the version, clears (unless preserveDiagnostics) and calls sendNotification,
\* all before its first await: one step. With Fence the fence request is sent
\* in the same tick (a request is ordered at sendRequest call time too).
RunnerStart ==
    /\ phase = "based"
    /\ phase' = "sent"
    /\ cliVer' = 1
    /\ IF Preserve \/ Mutant = "noClear"
         THEN UNCHANGED <<cache, timer, docVerRec, stamp>>
         ELSE ClearVars
    /\ IF Fence /\ Mutant # "fenceLate"
         THEN /\ wire' = wire \o << [k |-> "change", v |-> 1], [k |-> "fence", v |-> NONE] >>
              /\ fencing' = TRUE
         ELSE /\ wire' = Append(wire, [k |-> "change", v |-> 1])
              /\ UNCHANGED fencing
    /\ UNCHANGED <<baseline, gctr, srvVer, srvPrev, pubs, npubs, w, how, result>>

\* The send resolves; markTouched records A's content (index.ts ~5173).
RunnerFinish ==
    /\ phase = "sent"
    /\ phase' = "done"
    \* fenceLate mutant: the fence is sent and armed after the await.
    /\ IF Fence /\ Mutant = "fenceLate"
         THEN /\ wire' = Append(wire, [k |-> "fence", v |-> NONE])
              /\ fencing' = TRUE
         ELSE UNCHANGED <<wire, fencing>>
    /\ UNCHANGED <<baseline, cliVer, cache, docVerRec, stamp, gctr, timer,
                   srvVer, srvPrev, pubs, npubs, w, how, result>>

-----------------------------------------------------------------------------
\* The waiter: A after its notify, or the skipped touch B after A's markTouched.

\* clientWaitForDiagnostics entry: the early return, or register the
\* listener, in one synchronous tick (client.ts ~3905-3945).
WaitStart ==
    /\ w = "idle"
    /\ phase = "done"
    /\ IF FreshAt(stamp) /\ ~StaleAt(docVerRec) /\ cache.has /\ cache.ne
         THEN /\ w' = "resolved"
              /\ how' = "settled"
         ELSE /\ w' = "listen"
              /\ UNCHANGED how
    /\ UNCHANGED <<phase, baseline, cliVer, cache, docVerRec, stamp, gctr, timer,
                   fencing, wire, srvVer, srvPrev, pubs, npubs, result>>

\* The waiter's quiet-window timer fires: resolve (no re-check).
WaitSettle ==
    /\ w = "armed"
    /\ w' = "resolved"
    /\ how' = "settled"
    /\ UNCHANGED <<phase, baseline, cliVer, cache, docVerRec, stamp, gctr, timer,
                   fencing, wire, srvVer, srvPrev, pubs, npubs, result>>

\* The wait's own budget lapses.
WaitTimeout ==
    /\ w \in {"listen", "armed"}
    /\ w' = "resolved"
    /\ how' = "timeout"
    /\ UNCHANGED <<phase, baseline, cliVer, cache, docVerRec, stamp, gctr, timer,
                   fencing, wire, srvVer, srvPrev, pubs, npubs, result>>

\* touchFile reads getDiagnostics after further awaits (index.ts ~6583).
Read ==
    /\ w = "resolved"
    /\ w' = "read"
    /\ result' = cache
    /\ UNCHANGED <<phase, baseline, cliVer, cache, docVerRec, stamp, gctr, timer,
                   fencing, wire, srvVer, srvPrev, pubs, npubs, how>>

-----------------------------------------------------------------------------
\* The server.

ServerRead ==
    /\ wire # << >>
    /\ LET m == Head(wire) IN
         IF m.k = "change"
           THEN /\ srvPrev' = srvVer
                /\ srvVer' = m.v
                /\ UNCHANGED pubs
           ELSE /\ pubs' = Append(pubs, [k |-> "fenceReply", cv |-> NONE, dv |-> NONE, ne |-> FALSE])
                /\ UNCHANGED <<srvVer, srvPrev>>
    /\ wire' = Tail(wire)
    /\ UNCHANGED <<phase, baseline, cliVer, cache, docVerRec, stamp, gctr, timer,
                   fencing, npubs, w, how, result>>

ServerPublish ==
    /\ npubs < MaxPubs
    /\ \E c \in (IF AsyncServer THEN {srvVer, srvPrev} ELSE {srvVer}), ne \in BOOLEAN :
         pubs' = Append(pubs, [k |-> "pub", cv |-> c,
                               dv |-> IF VersionedServer THEN c ELSE NONE, ne |-> ne])
    /\ npubs' = npubs + 1
    /\ UNCHANGED <<phase, baseline, cliVer, cache, docVerRec, stamp, gctr, timer,
                   fencing, wire, srvVer, srvPrev, w, how, result>>

-----------------------------------------------------------------------------
\* The publishDiagnostics handler (client.ts ~2322-2578).

ClientReceive ==
    /\ pubs # << >>
    /\ pubs' = Tail(pubs)
    /\ LET p == Head(pubs) IN
       IF p.k = "fenceReply"
         THEN /\ fencing' = FALSE
              /\ UNCHANGED <<cache, docVerRec, stamp, gctr, timer, w>>
       ELSE IF Fence /\ fencing /\ p.dv = NONE
         THEN UNCHANGED <<fencing, cache, docVerRec, stamp, gctr, timer, w>>   \* fix: dropped
       ELSE IF SeedFirstPush /\ ~cache.has
         THEN /\ IF Superseded(p.dv)
                   THEN UNCHANGED <<cache, docVerRec, stamp, gctr, w>>
                   ELSE Store(p)
              /\ UNCHANGED <<fencing, timer>>
         ELSE /\ timer' = [on |-> TRUE, cv |-> p.cv, dv |-> p.dv, ne |-> p.ne]
              /\ UNCHANGED <<fencing, cache, docVerRec, stamp, gctr, w>>
    /\ UNCHANGED <<phase, baseline, cliVer, wire, srvVer, srvPrev, npubs, how, result>>

\* The handler's debounce timer fires and re-checks isSupersededPush.
TimerFire ==
    /\ timer.on
    /\ timer' = NoTimer
    /\ IF Superseded(timer.dv)
         THEN UNCHANGED <<cache, docVerRec, stamp, gctr, w>>
         ELSE Store(timer)
    /\ UNCHANGED <<phase, baseline, cliVer, fencing, wire, srvVer, srvPrev, pubs,
                   npubs, how, result>>

Next == Baseline \/ RunnerStart \/ RunnerFinish \/ WaitStart \/ WaitSettle
        \/ WaitTimeout \/ Read \/ ServerRead \/ ServerPublish \/ ClientReceive
        \/ TimerFire

Spec == Init /\ [][Next]_vars

-----------------------------------------------------------------------------

\* A wait that settled on diagnostics (early return or quiet window) hands
\* touchFile diagnostics computed for the content this touch sent (version 1),
\* or for newer content, never for older content. An empty cache is not a
\* result.
FreshResult == (w = "read" /\ how = "settled" /\ result.has) => result.cv >= 1

\* The same, including a wait that timed out and read whatever was cached.
FreshRead == (w = "read" /\ result.has) => result.cv >= 1

\* Sanity: a stale entry whose version is known is never cached after the send.
NoKnownStaleCached == (phase \in {"sent", "done"} /\ cache.has /\ docVerRec # NONE /\ ~Preserve)
                        => docVerRec >= cliVer
=============================================================================
