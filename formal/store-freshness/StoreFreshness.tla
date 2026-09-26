--------------------------- MODULE StoreFreshness ---------------------------
(***************************************************************************)
(* One cached result about ONE input file X, and the freshness gate that   *)
(* later decides whether the result may still be served (#1739 kernel      *)
(* stores). X is the file whose bytes the result was computed from: the    *)
(* diagnosed file itself (own axis) or a file it imports (dependency       *)
(* axis). The gate only ever looks at X.                                   *)
(*                                                                         *)
(* Actors:                                                                 *)
(*  - the writer: external or concurrent writes of X (a parallel bash      *)
(*    tool call, another pi-lens instance, an editor save, a formatter      *)
(*    write-back of a dependency in its own pipeline). Each write lands    *)
(*    new bytes and a new mtime. The mtime is the write's clock time plus *)
(*    a host lead of 0..Skew ticks (the #1710 Windows skew: mtime can LEAD *)
(*    Date.now()), truncated to the filesystem granularity Gran;           *)
(*  - the computation (scan, dispatch, LSP touch): Start, then Read (the   *)
(*    bytes the result is computed from), then Record (the store write).   *)
(*    Time may pass between any two steps;                                 *)
(*  - the store: what Record keeps (reference timestamp, recorded stat,    *)
(*    recorded content fingerprint);                                       *)
(*  - the reader: the gate, evaluated at any later time, one or more       *)
(*    times. A fresh verdict serves the result.                            *)
(*                                                                         *)
(* Time is an explicit clock of ticks (a tick is ~25 ms in the configs'    *)
(* comments). Several events may share one tick, which is how same-        *)
(* millisecond ties are represented.                                       *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS
    Writes,        \* external writes of X
    SizeMode,      \* "same": every write keeps X's byte length
                   \* "any":  a write may or may not change it
                   \* "grow": every write changes it
    MaxTime,       \* clock bound (ticks)
    Tol,           \* MTIME_DRIFT_TOLERANCE_MS in ticks
    Gran,          \* mtime granularity in ticks (1 = fine)
    Skew,          \* max ticks an mtime may lead the clock
    MinReadDelay,  \* ticks between Start and the computation's first read
    Stamp,         \* "start": reference taken at Start, before the read
                   \* "end":   reference taken at Record, after the read
    Gate,          \* "none":      always fresh (mutant: no gate)
                   \* "mtime":     stale iff mtime > ref + Tol (freshnessFromMtime)
                   \* "content":   stale iff size or hash differs from the bytes read
                   \* "sizeMtime": blocker self-drift: size first, then the
                   \*              mtime fast path, then the hash
                   \* "eq":        workspace-cache own file: recorded stat must
                   \*              equal the current stat (mtime [, size])
    ForceHash,     \* "sizeMtime": skip the mtime fast path, always hash
    SizeOnly,      \* "content": compare size only (mutant: no hash tier)
    StatAt,        \* "eq": "before" or "after" the read: when the recorded stat is taken
    SizeKey,       \* "eq": the recorded size is compared too (#2300)
    Binding,       \* "eq": the entry carries the content hash of the bytes
                   \*       read and a mismatch refuses the serve (#1095)
    BindingAt,     \* "eq": "read" = the hash describes the bytes the computation
                   \*       read (a push binding's sentHash); "record" = pi-lens
                   \*       hashes the disk after the answer (pull "full" report)
    MaxServes,     \* gate evaluations
    Latch,         \* a demotion is permanent (dependency-drift latch)
    AllowRegress,  \* a write may set an OLDER mtime (cp -p, tar, rsync -t)
    ServerLag      \* the computation may have read X BEFORE Start (a pull server
                   \* answering from a model it loaded earlier)

None == 1000   \* "no write yet" sentinel, larger than any clock value

VARIABLES
    now,
    disk, size, mtime,   \* X on disk: version, byte length, mtime (ms, vs Date.now())
    mtimeId,             \* sub-ms identity of the mtime: with Gran = 1 (a fine
                         \* filesystem, mtimeMs carries sub-ms digits) no two
                         \* writes share an mtimeMs; with coarse granularity
                         \* writes in one granule compare equal
    writesLeft,
    lastWriteAt,         \* clock of the most recent write (0 = initial content)
    comp,                \* "idle" | "readEarly" | "started" | "read" | "done"
    startAt,
    ref,                 \* the store's reference timestamp
    readVer, readSize,   \* the bytes the computation read
    recMtime, recSize,   \* "eq": the recorded stat
    recMtimeId,
    recHash,             \* "eq": the version the recorded content hash describes
    postReadWrite,       \* clock of the first write after the read, or None
    servesLeft,
    demotedBefore,       \* the gate has demoted this result at least once
    served,              \* records of every fresh verdict
    demoted              \* records of every stale verdict

vars == <<now, disk, size, mtime, mtimeId, recMtimeId, recHash, writesLeft, lastWriteAt, comp, startAt, ref,
          readVer, readSize, recMtime, recSize, postReadWrite, servesLeft,
          demotedBefore, served, demoted>>

MT(t) == t - (t % Gran)

Init ==
    /\ now = 0
    /\ disk = 1 /\ size = 1 /\ mtime = 0 /\ mtimeId = 0 /\ recMtimeId = 0 /\ recHash = 0
    /\ writesLeft = Writes /\ lastWriteAt = 0
    /\ comp = "idle" /\ startAt = 0 /\ ref = 0
    /\ readVer = 0 /\ readSize = 0 /\ recMtime = 0 /\ recSize = 0
    /\ postReadWrite = None
    /\ servesLeft = MaxServes /\ demotedBefore = FALSE
    /\ served = {} /\ demoted = {}

-----------------------------------------------------------------------------
Tick ==
    /\ now < MaxTime
    /\ now' = now + 1
    /\ UNCHANGED <<mtimeId, recMtimeId, recHash, disk, size, mtime, writesLeft, lastWriteAt, comp, startAt, ref,
                   readVer, readSize, recMtime, recSize, postReadWrite, servesLeft,
                   demotedBefore, served, demoted>>

Write ==
    /\ writesLeft > 0
    /\ writesLeft' = writesLeft - 1
    /\ disk' = disk + 1
    /\ CASE SizeMode = "same" -> size' = size
         [] SizeMode = "grow" -> size' = size + 1
         [] SizeMode = "any"  -> size' \in {size, size + 1}
    /\ \/ \E lead \in 0..Skew : mtime' = MT(now + lead)
       \/ AllowRegress /\ \E m \in 0..now : mtime' = MT(m)
    /\ mtimeId' = IF Gran = 1 THEN mtimeId + 1 ELSE 0
    /\ lastWriteAt' = now
    /\ postReadWrite' = IF comp \in {"readEarly", "read", "done"} /\ postReadWrite = None
                          THEN now ELSE postReadWrite
    /\ UNCHANGED <<now, comp, startAt, ref, readVer, readSize, recMtime, recSize,
                   recMtimeId, recHash, servesLeft, demotedBefore, served, demoted>>

Start ==
    /\ comp \in {"idle", "readEarly"}
    /\ comp' = IF comp = "idle" THEN "started" ELSE "read"
    /\ startAt' = now
    /\ ref' = IF Stamp = "start" THEN now ELSE ref
    /\ IF Gate = "eq" /\ StatAt = "before"
         THEN recMtime' = mtime /\ recSize' = size /\ recMtimeId' = mtimeId
         ELSE UNCHANGED <<recMtime, recSize, recMtimeId>>
    /\ UNCHANGED <<recHash, mtimeId, now, disk, size, mtime, writesLeft, lastWriteAt, readVer, readSize,
                   postReadWrite, servesLeft, demotedBefore, served, demoted>>

Read ==
    /\ comp = "started"
    /\ now >= startAt + MinReadDelay
    /\ comp' = "read"
    /\ readVer' = disk /\ readSize' = size
    /\ recHash' = IF BindingAt = "read" THEN disk ELSE recHash
    /\ UNCHANGED <<mtimeId, recMtimeId, now, disk, size, mtime, writesLeft, lastWriteAt, startAt, ref,
                   recMtime, recSize, postReadWrite, servesLeft, demotedBefore,
                   served, demoted>>

ReadEarly ==
    /\ ServerLag /\ comp = "idle"
    /\ comp' = "readEarly"
    /\ readVer' = disk /\ readSize' = size
    /\ recHash' = IF BindingAt = "read" THEN disk ELSE recHash
    /\ UNCHANGED <<mtimeId, recMtimeId, now, disk, size, mtime, writesLeft, lastWriteAt,
                   startAt, ref, recMtime, recSize, postReadWrite, servesLeft,
                   demotedBefore, served, demoted>>

Record ==
    /\ comp = "read"
    /\ comp' = "done"
    /\ ref' = IF Stamp = "end" THEN now ELSE ref
    /\ IF Gate = "eq" /\ StatAt = "after"
         THEN recMtime' = mtime /\ recSize' = size /\ recMtimeId' = mtimeId
         ELSE UNCHANGED <<recMtime, recSize, recMtimeId>>
    /\ recHash' = IF BindingAt = "record" THEN disk ELSE recHash
    /\ UNCHANGED <<mtimeId, now, disk, size, mtime, writesLeft, lastWriteAt, startAt, readVer,
                   readSize, postReadWrite, servesLeft, demotedBefore, served, demoted>>

-----------------------------------------------------------------------------
MtimeStale == mtime > ref + Tol
HashDiffers == disk /= readVer          \* sha256 of disk vs of the bytes read

IsStale ==
    CASE Gate = "none"      -> FALSE
      [] Gate = "mtime"     -> MtimeStale
      [] Gate = "content"   -> size /= readSize \/ (~SizeOnly /\ HashDiffers)
      [] Gate = "sizeMtime" -> \/ size /= readSize
                               \/ (ForceHash \/ MtimeStale) /\ HashDiffers
      [] Gate = "eq"        -> \/ mtime /= recMtime \/ mtimeId /= recMtimeId
                               \/ SizeKey /\ size /= recSize
                               \/ Binding /\ disk /= recHash

Observation == [ver |-> readVer, disk |-> disk, ref |-> ref, w |-> postReadWrite,
                lastWriteAt |-> lastWriteAt, afterDemotion |-> demotedBefore]

GateCheck ==
    /\ comp = "done" /\ servesLeft > 0
    /\ servesLeft' = servesLeft - 1
    /\ IF (Latch /\ demotedBefore) \/ IsStale
         THEN /\ demoted' = demoted \cup {Observation}
              /\ demotedBefore' = TRUE
              /\ UNCHANGED served
         ELSE /\ served' = served \cup {Observation}
              /\ UNCHANGED <<demoted, demotedBefore>>
    /\ UNCHANGED <<now, disk, size, mtime, writesLeft, lastWriteAt, comp, startAt, ref,
                   readVer, readSize, recMtime, recSize, postReadWrite, mtimeId,
                   recMtimeId, recHash>>

Next == Tick \/ Write \/ Start \/ ReadEarly \/ Read \/ Record \/ GateCheck

Spec == Init /\ [][Next]_vars

-----------------------------------------------------------------------------
(* The stores' promise: a result is never served for a file modified after *)
(* the content it was computed from.                                       *)
NoStaleServe == \A s \in served : s.ver = s.disk

(* The same promise minus the admitted tolerance window (#1710): a stale   *)
(* serve is excused only when the first write after the read landed AT OR  *)
(* AFTER the reference instant and within tolerance + granularity of it.   *)
(* A write that landed BEFORE the reference (between the read and a late   *)
(* stamp) is never excused.                                                *)
InWindow(s) == s.w /= None /\ s.ref <= s.w /\ s.w < s.ref + Tol + Gran
NoStaleServeBeyondTol == \A s \in served : s.ver = s.disk \/ InWindow(s)

(* The reason the tolerance exists: a result computed on the bytes still   *)
(* on disk, with no write since the reference instant, is not demoted.     *)
NoSpuriousDemotion ==
    \A d \in demoted : d.ver = d.disk => d.lastWriteAt > d.ref

(* A demoted result is not re-promoted unless the bytes match again.       *)
NoRepromotion == \A s \in served : s.afterDemotion => s.ver = s.disk

(* Sanity: the gate can serve at all (checked as a violated invariant).    *)
NeverServes == served = {}
=============================================================================
