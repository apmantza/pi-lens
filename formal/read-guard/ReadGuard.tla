------------------------------ MODULE ReadGuard ------------------------------
(***************************************************************************)
(* The read-before-edit guard (clients/read-guard.ts checkEdit) for one    *)
(* file F, seen                                                            *)
(* from a POSITIONAL edit tool (oldRange / edits[].range / hashline): the  *)
(* class of edit the guard fully enforces. An oldText edit is content-     *)
(* validated by the host and skips FileTime, snapshot and (as a block)     *)
(* coverage (runtime-tool-call.ts skipSnapshotCheck/oldTextResolved),      *)
(* so it is out of scope.                                                  *)
(*                                                                         *)
(* A file is a sequence of line tokens. Every write mints fresh tokens, so *)
(* token equality is content equality (lineContentHash is whitespace-      *)
(* stripped; a whitespace-only rewrite is modelled as no change).          *)
(*                                                                         *)
(* Actors:                                                                 *)
(*  - the agent (one tool at a time; pi awaits each handler):              *)
(*      read   : tool_call provisional record (runtime-tool-call.ts,       *)
(*               hashes + FileTime taken at tool_call), host read, then    *)
(*               the tool_result record (runtime-tool-result.ts            *)
(*               handleToolResult)                                         *)
(*               that supersedes it (from the delivered bytes when the     *)
(*               file moved after the tool_call's stamp, #3524);           *)
(*               both records carry one evidence identity: the top-level    *)
(*               toolCallId, or the parent codemode toolCallId for a nested *)
(*               read, because the parent result is the branch-visible     *)
(*               transcript entry (#4138/#3831).                            *)
(*      edit   : positional edit of 1 or 2 lines; checkEdit at tool_call   *)
(*               (runtime-tool-call.ts handleToolCall), optional           *)
(*               relocation                                                *)
(*               then host apply, then recordWritten at tool_result        *)
(*               (runtime-tool-result.ts handleToolResult), with the       *)
(*               written lines                                             *)
(*               recorded as read when not relocated (#3523);              *)
(*      write  : noteCreatedFile at tool_call, host write,                 *)
(*               recordWritten (injects the creation read,                 *)
(*               read-guard.ts).                                           *)
(*      bash   : a recognized bash write (runtime-tool-result.ts           *)
(*               handleToolResult): recordWritten, no creation read, no    *)
(*               FileTime stamp (#3525).                                   *)
(*               The turn's first write runs the immediate                 *)
(*               autofix (pipeline.ts runAutofix), recordWritten again     *)
(*               (runtime-tool-result.ts handleToolResult), and the        *)
(*               post-fix                                                  *)
(*               bytes are attached as "authoritative" and                 *)
(*               recorded as a whole-file read (#3519).                    *)
(*      own    : an owned in-process write (#4187 R4-1): a pi-lens tool    *)
(*               that writes bytes of its own (ast_grep_replace with       *)
(*               apply: true, an lsp_navigation rename,                    *)
(*               lens_diagnostic_mark's suppress). Its tool_call retires a *)
(*               broken authorship for the paths it named and licenses an  *)
(*               advance for exactly those (read-guard.ts                  *)
(*               noteCheckedPaths); the write then re-baselines a licensed *)
(*               path and ends every other one. Two steps (OwnCall,        *)
(*               OwnWrite), so another writer may land inside the tool's   *)
(*               run, after the check that licensed it (R4-6).             *)
(*  - another writer (external editor, second pi-lens instance, git):      *)
(*    changes F between any two steps.                                     *)
(*  - pi-lens' deferred agent_end format drain (runtime-agent-end.ts       *)
(*  handleAgentEnd):                                                       *)
(*    rewrites F, then recordWritten: authorship only since #3525, which   *)
(*    leaves FileTime where it was (FormatStamp).                          *)
(*  - boundaries: user turn (kTurn = what the agent knew before the        *)
(*    prompt), /new (fresh guard), /fork (the conversation restarts BEFORE *)
(*    a chosen user message) and /tree (the conversation moves). Since     *)
(*    #3521 both keep exactly the records whose tool result is on the new  *)
(*    branch (BranchFilter); before it, /fork imported nothing and /tree   *)
(*    left the guard untouched.                                            *)
(*                                                                         *)
(* The agent's knowledge `know` is what the conversation shows it: read    *)
(* results, its own edits and writes, the authoritative attachment.        *)
(***************************************************************************)
EXTENDS Integers, Sequences, FiniteSets

CONSTANTS
    N0,             \* initial line count
    MaxLen,         \* longest file
    AgentOps,       \* bound on agent tool calls
    Ops,            \* agent tool kinds: subset of {"read","rread","fread","bread","edit","oedit","write","bash",
                    \*  "pbash","bridge","own","ownwrite"}
                    \* ("fread": a read whose host call errors, offset past EOF;
                    \*  "bread": a read a later extension blocks after pi-lens's tool_call captured it;
                    \*  "oedit": an oldText edit, gated by the zero-read check alone;
                    \*  "pbash": a recognized bash write of one line;
                    \*  "settle": unattributed settled-sweep drift;
                    \*  "bridge": a mutation-bridge write of one line, with no pre-write check of its own;
                    \*  "own": an owned in-process call+write pair, the call licensing the write's advance;
                    \*  "ownwrite": the same write with no call, the round-4 mutant)
    Spans,          \* edit spans: subset of {1,2}
    ExtWrites,      \* bound on other-writer writes
    ExtKinds,       \* subset of {"replace","delete","insert"}
    ExtPhases,      \* where the other writer may land: subset of {"idle","inflight"}
    FixKind,        \* immediate autofix: "none" | "replace" | "delete" | "insert" (at line 1)
    FormatDrain,    \* agent_end format: "none" | "replace" | "delete" | "insert" (at line 1)
    Bounds,         \* boundaries: subset of {"turn","new","fork","tree"}
    MaxBounds,      \* bound on boundaries
    Hashes,         \* TRUE: read records carry line hashes (file <= READ_HASH_MAX_LINES)
    Ctx,            \* contextLines (DEFAULT_CONFIG: 3)
    \* ---- current-code switches ----
    HandlerEvidence,\* TRUE (pre-#3524 code): a native read's hashes, range and FileTime come from disk at tool_result
    CreationHandlerEvidence, \* TRUE (code before #3524's remainder): the injected creation read is hashed from disk at tool_result
    MtimeAuthored,  \* TRUE (code before #3520): zero-read allow when mtime >= guard construction; FALSE: only `written` authors
    OwnEditRescue,  \* TRUE (code before #3525): canTreatStalenessAsOwnPriorEdit
    ForkImport,     \* FALSE (code before #3521): pi re-runs the factory for a fork, so the closure stash died and the fork imported nothing
    SuppressByNewerContext, \* TRUE (code before #3522): a newer context-only candidate cancels a snapshot mismatch; read only when SpanSnapshot = FALSE
    FormatStamp,    \* TRUE (code before #3525): the agent_end format drain's recordWritten also stamps FileTime
                    \* (FALSE: it credits authorship, `written`, only)
    ProvisionalCredit, \* TRUE (#4185 round 1, head 2ce73f165): the tool_call provisional record carries the
                       \* transcript identity (toolCallId), so a /fork or /tree keeps it like a delivered
                       \* record; FALSE (code before #4185 and since its round 2): it has none and every
                       \* move drops it. Only a read that errored leaves one behind (FailedRead).
    RevokeFailedRead,  \* TRUE (code since #4185 round 2): the end of a read call that errored drops the
                       \* tool_call capture (at tool_result in rounds 2-3, at tool_execution_end since round 4,
                       \* ReadGuard.dropProvisionalReadByCall); FALSE (code before): the capture stays, and
                       \* alone it satisfies the zero-read check (FailedReadLive)
    BlockRelease,      \* where the capture of a read blocked after its tool_call ("bread") is released:
                       \* "none" (code before #4185 round 3): never, and no run-boundary backstop;
                       \* "run" (#4185 round 3, head aa4f1f125): only at the run boundary (agent_settled,
                       \*   Turn here), which drops every capture still held;
                       \* "end" (code since round 4): at the call's tool_execution_end, with the
                       \*   run-boundary drop kept as a backstop
    \* ---- candidate fixes ----
    RecordAuthoritative, \* record the attached post-autofix bytes as a full read (code since #3519)
    RecordOwnEdit,       \* record the lines an allowed positional edit wrote as read (code since #3523)
    OwnEditSkipsReloc,   \* TRUE (code): ... but not when the edit was relocated
    SpanSnapshot,        \* TRUE (code since #3522): check each line of the range against the newest read that delivered it
    RelocFromLatest,     \* TRUE (code since #3522): relocate only from a read that is the agent's latest view of every line
    WholeVouchesPastEnd, \* FALSE (code): a whole-file view also vouches that lines past its end do not exist (#3522 part 3; no invariant needs it)
    ForkAtBoundary,      \* fork/tree: forget reads made after the fork point
    BranchFilter,        \* TRUE (code since #3521): fork/tree keep the branch's records whole, clear FileTime, written, pendCreate and the own-edit rescue, and re-anchor born (read only when MtimeAuthored)
    DrainMode,           \* "atomic": the format drain runs inside Turn (no /tree can interleave);
                         \* "unfenced": it is queued at settle and may land after a /tree (code before #3521 round 2);
                         \* "settle": the same, and its recordWritten is refused once a /tree moved the branch
                         \*   since the settle that dequeued it (#3521 round 2);
                         \* "fenced": the refusal is against the epoch the work was queued with, which a
                         \*   Requeue keeps (code since #3521 round 3)
    \* ---- existing guards (FALSE = mutant with the guard removed) ----
    FileTimeCheck, CoverageCheck, SnapshotCheck,
    \* ---- authorship (#4131, #4187) ----
    AuthorIdentity, \* TRUE (code since #4187): authorship holds the bytes the conversation last wrote and
                    \*   ends when the disk differs (content identity; stat is only the code's pre-filter);
                    \*   FALSE (code before): any recordWritten authors the file until a branch move
    RetireAtWrite,  \* TRUE (code since #4187): a write that carries no bytes of its own (a bash write's
                    \*   tool_call, the agent_end drain) first ends an authorship whose bytes changed, and
                    \*   no later write resumes it; FALSE: it re-baselines over the other writer's bytes
    AuthorBranch,   \* TRUE (code since #4187, #3603): /tree and /fork keep the authorship whose write is
                    \*   on the kept branch; FALSE (code before): they clear every authorship
    BridgeNoAdvance \* TRUE (code since #4187 round 3, R2-4): a mutation-bridge write, which no pre-write
                    \*   check guarded, ends an existing authorship whose bytes it changed instead of
                    \*   advancing it; FALSE (round 2): it re-baselines like an own write

Lines == 1..MaxLen
\* The license switch reuses the existing boolean in the focused configs;
\* configs without an own-repeat action are unchanged by this abstraction.
SpendLicense == BridgeNoAdvance
NoH == [l \in Lines |-> 0]
Min(a, b) == IF a < b THEN a ELSE b

\* A hash map of `c` over lo..hi (0 = no hash).
MkH(c, lo, hi) ==
    [l \in Lines |-> IF Hashes /\ lo <= l /\ l <= hi /\ l <= Len(c) THEN c[l] ELSE 0]


Replace(s, l, t) == [s EXCEPT ![l] = t]
Delete(s, l) == SubSeq(s, 1, l - 1) \o SubSeq(s, l + 1, Len(s))
Insert(s, l, t) == SubSeq(s, 1, l - 1) \o <<t>> \o SubSeq(s, l, Len(s))
\* "ws" (a formatter's whitespace-only rewrite, #4187): new mtime, same tokens.
Mod(kind, s, l, t) ==
    CASE kind = "replace" -> Replace(s, l, t)
      [] kind = "delete"  -> Delete(s, l)
      [] kind = "insert"  -> Insert(s, l, t)
      [] kind = "ws"      -> s
ModOk(kind, s, l) ==
    CASE kind = "replace" -> l <= Len(s)
      [] kind = "delete"  -> l <= Len(s) /\ Len(s) >= 2
      [] kind = "insert"  -> l <= Len(s) + 1 /\ Len(s) < MaxLen
      [] kind = "ws"      -> l <= Len(s)

VARIABLES
    disk, rev, tok,             \* file content, write counter (= mtime clock), fresh-token source
    know, kTurn,                \* agent knowledge; knowledge before the current prompt
    reads, ft, written, pendCreate, lastEditOk, born, turnNo,  \* guard state
                                \* (written: the authorship record, see NoAuth/Auth)
    pc, pend, ops, ext, nb, fixedTurn, mutatedTurn,
    dr,                         \* settle drain: queued (q), branch epoch it carries (ep), current epoch (cur),
                                \* work put back by an aborted or failed drain (rq)
    staleAllow, blindAllow, falseBlock  \* ghost verdict flags

vars == <<disk, rev, tok, know, kTurn, reads, ft, written, pendCreate, lastEditOk,
          born, turnNo, pc, pend, ops, ext, nb, fixedTurn, mutatedTurn, dr,
          staleAllow, blindAllow, falseBlock>>

guardVars == <<reads, ft, written, pendCreate, lastEditOk, born, turnNo, dr>>

\* g = turn the record was made in (ReadRecord.turnIndex); whole = whole-file view.
Rec(lo, hi, h, prov) == [lo |-> lo, hi |-> hi, h |-> h, prov |-> prov, g |-> turnNo, whole |-> FALSE]

\* The authorship record (writtenThisSession, AuthoredBytes): on = an
\* entry exists; c = the bytes it was credited over (its content identity);
\* g = the turn of the write that named it, id = whether one did (a pi-lens
\* writer names none and keeps the id of the bytes it rewrote); ret = it was
\* retired because another writer changed the bytes (#4131). A retired record
\* stays (no write resumes it) and moves with its write like a live one.
NoAuth == [on |-> FALSE, c |-> <<>>, g |-> 0, id |-> FALSE, ret |-> FALSE, lic |-> FALSE]
\* recordWritten by a write that names its transcript entry.
Auth(c) == IF written.ret THEN written
           ELSE [on |-> TRUE, c |-> c, g |-> turnNo, id |-> TRUE, ret |-> FALSE, lic |-> FALSE]
\* recordWritten by a pi-lens writer: carries the id of the write it rewrote.
Carry(c) == IF written.ret THEN written
            ELSE IF written.on THEN [written EXCEPT !.c = c]
            ELSE [on |-> TRUE, c |-> c, g |-> turnNo, id |-> FALSE, ret |-> FALSE, lic |-> FALSE]
\* The zero-read arm's authorship question (ReadGuard.checkEdit).
Authored == written.on /\ ~written.ret /\ (AuthorIdentity => written.c = disk)
\* retireChangedAuthorship at the start of a write that carries no bytes of its own.
Broken == RetireAtWrite /\ written.on /\ (written.ret \/ written.c # disk)
Retired == [written EXCEPT !.ret = TRUE]
\* retainBranch / importAuthorship (#3603): the authorship, retired or not,
\* stays iff the write that named it is on the kept branch (made before the
\* prompt the move returns to, as BeforePrompt asks of a read).
KeptAuth == IF AuthorBranch /\ written.on /\ written.id /\ written.g < turnNo
              THEN written ELSE NoAuth

Init ==
    /\ disk = [l \in 1..N0 |-> l] /\ rev = 0 /\ tok = N0 + 1
    /\ know = [l \in Lines |-> 0] /\ kTurn = know
    /\ reads = <<>> /\ ft = -1 /\ written = NoAuth /\ pendCreate = FALSE
    /\ lastEditOk = FALSE /\ born = 0 /\ turnNo = 0
    /\ pc = "idle" /\ pend = [k |-> "none"] /\ ops = 0 /\ ext = 0 /\ nb = 0
    /\ fixedTurn = FALSE /\ mutatedTurn = FALSE
    /\ dr = [q |-> FALSE, ep |-> 0, cur |-> 0, rq |-> FALSE]
    /\ staleAllow = FALSE /\ blindAllow = FALSE /\ falseBlock = FALSE

KnowAll(c) == [l \in Lines |-> IF l <= Len(c) THEN c[l] ELSE 0]

\* A whole-file view (full read, creation read, attachment) is the agent's view
\* of every line, including "no such line" past its end (fix 4, part 3).
AddRec(S, r, whole) == Append(S, [r EXCEPT !.whole = whole])

----------------------------------------------------------------------------
\* Guard predicates (read-guard.ts checkEdit). Record order in `reads` is timestamp order.
Max(a, b) == IF a > b THEN a ELSE b
\* readCoversRange: the effective range widened by contextLines.
CtxCovers(r, lo, hi) == Max(1, r.lo - Ctx) <= lo /\ hi <= r.hi + Ctx
EffCovers(r, lo, hi) == r.lo <= lo /\ hi <= r.hi
HashesMatch(r, lo, hi) ==                                       \* readRangeHashesStillMatch
    \A l \in lo..hi : r.lo <= l /\ l <= r.hi /\ r.h[l] # 0 /\ l <= Len(disk) /\ r.h[l] = disk[l]
AllHashesMatch(r) ==                                            \* readHashesStillMatch
    /\ \E l \in Lines : r.h[l] # 0
    /\ \A l \in Lines : r.h[l] # 0 => (l <= Len(disk) /\ r.h[l] = disk[l])
Idx(S) == 1..Len(S)
LastIdx(S) == IF S = {} THEN 0 ELSE CHOOSE i \in S : \A j \in S : j <= i

\* checkCoverage: the union of non-provisional, context-widened ranges.
Covered(lo, hi) ==
    \A l \in lo..hi : \E i \in Idx(reads) :
        ~reads[i].prov /\ Max(1, reads[i].lo - Ctx) <= l /\ l <= reads[i].hi + Ctx

\* canIgnoreStalenessByHashes.
HashRescueCode(lo, hi) == \E i \in Idx(reads) : CtxCovers(reads[i], lo, hi) /\ HashesMatch(reads[i], lo, hi)

\* validateRangeSnapshot. A candidate is "checked" when it delivered
\* and hashed every line of the range (currentLinesMatchReadSnapshot);
\* otherwise it is "unavailable". The block is suppressed when an unavailable
\* candidate is newer than the newest mismatch.
Cands(lo, hi) == {i \in Idx(reads) : CtxCovers(reads[i], lo, hi)}
Checked(lo, hi) ==
    {i \in Cands(lo, hi) : EffCovers(reads[i], lo, hi) /\ \A l \in lo..hi : reads[i].h[l] # 0}
Unavail(lo, hi) == Cands(lo, hi) \ Checked(lo, hi)
HashUnavail(lo, hi) == {i \in Unavail(lo, hi) : EffCovers(reads[i], lo, hi)}
SnapMatch(lo, hi) == \E i \in Checked(lo, hi) : HashesMatch(reads[i], lo, hi)
SnapBlock(lo, hi) ==
    /\ SnapshotCheck
    /\ Checked(lo, hi) # {}
    /\ ~SnapMatch(lo, hi)
    /\ (SuppressByNewerContext => LastIdx(Unavail(lo, hi)) <= LastIdx(Checked(lo, hi)))
    /\ HashUnavail(lo, hi) = {}

\* SpanSnapshot (code since #3522): every line of the range is compared with the
\* newest read that DELIVERED it (the agent's latest view of that line).
NewestDeliv(l) == LastIdx({i \in Idx(reads) : ~reads[i].prov
                              /\ ((reads[i].lo <= l /\ l <= reads[i].hi /\ reads[i].h[l] # 0)
                                  \/ (WholeVouchesPastEnd /\ reads[i].whole))})
SpanBlock(lo, hi) ==
    /\ SnapshotCheck
    /\ \E l \in lo..hi : NewestDeliv(l) # 0
         /\ (l > Len(disk) \/ reads[NewestDeliv(l)].h[l] # disk[l])
StaleRange(lo, hi) == IF SpanSnapshot THEN SpanBlock(lo, hi) ELSE SnapBlock(lo, hi)
\* ... and the FileTime rescue asks the same per-line question.
HashRescue(lo, hi) ==
    IF SpanSnapshot
      THEN \A l \in lo..hi : NewestDeliv(l) # 0 /\ l <= Len(disk) /\ reads[NewestDeliv(l)].h[l] # 0
                             /\ reads[NewestDeliv(l)].h[l] = disk[l]
      ELSE HashRescueCode(lo, hi)

\* findRelocation: newest read with hashes for the whole range; its
\* sequence must occur exactly once in the current file (the window is wider
\* than the file here).
HasSeq(i, lo, hi) == \A l \in lo..hi : reads[i].h[l] # 0
RelocSrc(lo, hi) ==
    LET W == {i \in Idx(reads) : HasSeq(i, lo, hi)
                 /\ (RelocFromLatest => \A l \in lo..hi : NewestDeliv(l) = i)}
    IN IF W = {} THEN 0 ELSE CHOOSE i \in W : \A j \in W : j <= i
MatchAt(i, lo, hi, s) ==
    s + (hi - lo) <= Len(disk) /\ \A d \in 0..(hi - lo) : disk[s + d] = reads[i].h[lo + d]
Reloc(lo, hi) ==
    IF hi - lo < 1 THEN 0
    ELSE LET i == RelocSrc(lo, hi)
         IN IF i = 0 THEN 0
            ELSE LET M == {s \in 1..Len(disk) : MatchAt(i, lo, hi, s)}
                 IN IF Cardinality(M) = 1 /\ (CHOOSE s \in M : TRUE) # lo
                      THEN CHOOSE s \in M : TRUE ELSE 0

\* checkEdit for a positional edit of lo..hi.
\* Returns [act |-> "allow"|"block"|"reloc", to |-> start, inject |-> BOOLEAN].
Verdict(lo, hi) ==
    IF Len(reads) = 0
    THEN IF Authored \/ (MtimeAuthored /\ rev > born)           \* the zero-read authorship check (writtenThisSession)
           THEN [act |-> "allow", to |-> lo, inject |-> TRUE, why |-> "session_authored"]
           ELSE [act |-> "block", to |-> lo, inject |-> FALSE,
                 why |-> IF written.on THEN "authorship_retired" ELSE "zero_read"]
    ELSE IF FileTimeCheck /\ ft # rev
             /\ ~(OwnEditRescue /\ lastEditOk)
             /\ ~HashRescue(lo, hi)
    THEN [act |-> "block", to |-> lo, inject |-> FALSE, why |-> "file_modified"]
    ELSE IF CoverageCheck /\ ~Covered(lo, hi)
    THEN [act |-> "block", to |-> lo, inject |-> FALSE, why |-> "out_of_range"]
    ELSE IF StaleRange(lo, hi)
    THEN IF Reloc(lo, hi) # 0
           THEN [act |-> "reloc", to |-> Reloc(lo, hi), inject |-> FALSE, why |-> "range_stale_relocated"]
           ELSE [act |-> "block", to |-> lo, inject |-> FALSE, why |-> "range_stale"]
    ELSE [act |-> "allow", to |-> lo, inject |-> FALSE, why |-> "range_coverage"]

\* checkEdit for an oldText edit (runtime-tool-call.ts skipSnapshotCheck /
\* oldTextResolved): the host validates the text, so FileTime and the snapshot
\* are skipped and out-of-range is a warning; the zero-read check alone gates
\* it, and a provisional record satisfies it (`fileReads.length === 0`).
VerdictOldText(lo, hi) ==
    IF Len(reads) = 0
    THEN IF Authored \/ (MtimeAuthored /\ rev > born)
           THEN [act |-> "allow", to |-> lo, inject |-> TRUE, why |-> "session_authored"]
           ELSE [act |-> "block", to |-> lo, inject |-> FALSE, why |-> "zero_read"]
    ELSE [act |-> "allow", to |-> lo, inject |-> FALSE, why |-> "old_text"]

----------------------------------------------------------------------------
Idle == pc = "idle"
CanOp(k) == Idle /\ ops < AgentOps /\ k \in Ops

\* ---- read (full: "read", ranged: "rread") ----
\* tool_call: provisional record; a full read with no limit records line 1.
ReadCall(full, lo, hi) ==
    /\ CanOp(IF full THEN "read" ELSE "rread")
    /\ IF full THEN lo = 1 /\ hi = MaxLen ELSE lo <= hi /\ hi <= Len(disk)
    /\ LET plo == lo
           phi == IF full THEN 1 ELSE hi
       IN reads' = Append(reads, Rec(plo, phi, MkH(disk, plo, phi), TRUE))
    /\ ft' = rev
    /\ lastEditOk' = FALSE
    /\ pc' = "readExec" /\ pend' = [k |-> "read", full |-> full, lo |-> lo, hi |-> hi]
    /\ ops' = ops + 1
    /\ UNCHANGED <<disk, rev, tok, know, kTurn, written, pendCreate, born, turnNo,
                   ext, nb, fixedTurn, mutatedTurn, dr, staleAllow, blindAllow, falseBlock>>

\* host read: the bytes delivered to the agent.
ReadExec ==
    /\ pc = "readExec"
    /\ LET hi == IF pend.full THEN Len(disk) ELSE Min(pend.hi, Len(disk))
       IN pend' = [k |-> "read", full |-> pend.full, lo |-> pend.lo, hi |-> hi,
                   view |-> KnowAll(disk)]
    /\ pc' = "readResult"
    /\ UNCHANGED <<disk, rev, tok, know, kTurn, guardVars, ops, ext, nb, fixedTurn,
                   mutatedTurn, staleAllow, blindAllow, falseBlock>>

\* tool_result: supersede the provisional record with the delivered range.
\* HandlerEvidence (pre-#3524): range (countFileLines), hashes and FileTime
\* taken from disk NOW.
\* Code since #3524: when the file moved after the tool_call's FileTime stamp
\* (ft # rev), hashes and range come from the delivered bytes (pi's own line
\* count), and FileTime keeps the tool_call stamp. Otherwise the disk still
\* holds the delivered bytes, and the record re-stamps.
ReadResult ==
    /\ pc = "readResult"
    /\ LET lo == pend.lo
           nowHi == IF pend.full THEN Len(disk) ELSE Min(pend.hi, Len(disk))
           hi == IF HandlerEvidence THEN nowHi ELSE pend.hi
           h == IF HandlerEvidence THEN MkH(disk, lo, hi) ELSE MkH(pend.view, lo, hi)
           provIdx == CHOOSE i \in Idx(reads) : reads[i].prov
                        /\ \A j \in Idx(reads) : reads[j].prov => j <= i
           rest == [j \in 1..(Len(reads) - 1) |->
                      IF j < provIdx THEN reads[j] ELSE reads[j + 1]]
       IN /\ reads' = IF lo <= hi THEN AddRec(rest, Rec(lo, hi, h, FALSE), pend.full) ELSE rest
          /\ ft' = IF HandlerEvidence \/ ft = rev THEN rev ELSE ft
    /\ know' = [l \in Lines |->
                  IF pend.lo <= l /\ l <= pend.hi THEN pend.view[l]
                  ELSE IF pend.full THEN 0 ELSE know[l]]
    /\ lastEditOk' = FALSE
    /\ pc' = "idle" /\ pend' = [k |-> "none"]
    /\ UNCHANGED <<disk, rev, tok, kTurn, written, pendCreate, born, turnNo,
                   ops, ext, nb, fixedTurn, mutatedTurn, dr, staleAllow, blindAllow, falseBlock>>

\* ---- a read that errors (offset past EOF): "fread" ----
\* tool_call records the capture (runtime-tool-call.ts handleToolCall) and
\* stamps FileTime; the host returns an error; tool_result delivers nothing
\* (runtime-tool-result.ts handleToolResult keeps the native-read block behind
\* `isError !== true`) and, since #4185 round 2, the call's end drops the
\* capture (RevokeFailedRead; tool_execution_end since round 4, which pi emits
\* right after the tool_result handlers). Before it the capture stayed: the one
\* record that could be provisional at a boundary (#4185 round 1, F1) and,
\* live, the one record the zero-read check of an oldText edit counted
\* (FailedReadLive). One step: no other tool_call of the run can land between
\* the tool_call and tool_execution_end of a call the host executed.
FailedRead ==
    /\ CanOp("fread")
    /\ reads' = IF RevokeFailedRead THEN reads
                ELSE Append(reads, Rec(Len(disk) + 1, Len(disk) + 1, NoH, TRUE))
    /\ ft' = rev
    /\ lastEditOk' = FALSE
    /\ ops' = ops + 1
    /\ UNCHANGED <<disk, rev, tok, know, kTurn, written, pendCreate, born, turnNo, pc, pend,
                   ext, nb, fixedTurn, mutatedTurn, dr, staleAllow, blindAllow, falseBlock>>

\* ---- a read a later extension blocks: "bread" (#4185 round 3 R3-2) ----
\* pi-lens's tool_call handler records the capture and stamps FileTime; then
\* an extension loaded after pi-lens blocks the call. pi emits no tool_result
\* and the agent sees no bytes (know is unchanged), but it does emit
\* tool_execution_end for the call (agent-loop.js, the "immediate" result),
\* before the next tool_call of the run. Two steps, because the capture lives
\* from the block to whichever action releases it, and an edit later in the
\* same run (the next LLM turn, the same message, the same codemode script)
\* can run in between when the release is the run boundary.
BlockedReadCall ==
    /\ CanOp("bread")
    /\ reads' = Append(reads, Rec(1, 1, MkH(disk, 1, 1), TRUE))
    /\ ft' = rev
    /\ lastEditOk' = FALSE
    /\ pc' = "blocked"
    /\ ops' = ops + 1
    /\ UNCHANGED <<disk, rev, tok, know, kTurn, written, pendCreate, born, turnNo, pend,
                   ext, nb, fixedTurn, mutatedTurn, dr, staleAllow, blindAllow, falseBlock>>

\* tool_execution_end of the blocked call (index.ts -> handleToolExecutionEnd):
\* "end" releases this call's capture, the newest record (one tool at a time,
\* and nothing else writes `reads` while the call is open).
BlockedReadEnd ==
    /\ pc = "blocked"
    /\ reads' = IF BlockRelease = "end" THEN SubSeq(reads, 1, Len(reads) - 1) ELSE reads
    /\ pc' = "idle"
    /\ UNCHANGED <<disk, rev, tok, know, kTurn, ft, written, pendCreate, lastEditOk, born, turnNo,
                   pend, ops, ext, nb, fixedTurn, mutatedTurn, dr, staleAllow, blindAllow, falseBlock>>

\* ---- edit of lo..lo+span-1 (checkEdit at tool_call, host apply) ----
\* Positional ("edit"): the guard fully enforces it. oldText ("oedit"): the
\* host validates the text, so the guard runs the zero-read check alone
\* (VerdictOldText), the host applies only when the agent's text matches the
\* disk, and no own-edit read is recorded (#3760: only a single edits[].range
\* replacement is). A blind oldText edit is the agent guessing text it was
\* never shown; the guess that happens to match lands, and any allow of it is
\* the false allow the zero-read check exists to refuse.
Edit(lo, span, oldText) ==
    /\ CanOp(IF oldText THEN "oedit" ELSE "edit") /\ span \in Spans
    /\ lo + span - 1 <= MaxLen
    \* know[l] = 0 is a blind edit (line numbers the agent never saw): any
    \* allow of it is a false allow.
    /\ LET hi == lo + span - 1
           v == IF oldText THEN VerdictOldText(lo, hi) ELSE Verdict(lo, hi)
           tg == v.to
           inDisk == tg + span - 1 <= Len(disk)
           ok == inDisk /\ \A d \in 0..(span - 1) : disk[tg + d] = know[lo + d]
           exact == hi <= Len(disk) /\ \A l \in lo..hi : know[l] = disk[l]
           new == [d \in 0..(span - 1) |-> tok + d]
           injected == IF v.inject THEN AddRec(reads, Rec(1, Len(disk), MkH(disk, 1, Len(disk)), FALSE), TRUE)
                       ELSE reads
           relocRead == IF v.act = "reloc"
                          THEN Append(injected, Rec(tg, tg + span - 1, MkH(disk, tg, tg + span - 1), FALSE))
                          ELSE injected
           blind == \E l \in lo..hi : know[l] = 0
           \* An allowed edit past EOF fails in the host, so only edits that land
           \* count; the host also refuses an oldText that no longer matches.
           lands == inDisk /\ (~oldText \/ ok \/ blind)
       IN /\ staleAllow' = (staleAllow \/ (~oldText /\ v.act # "block" /\ inDisk /\ ~blind /\ ~ok))
          /\ blindAllow' = (blindAllow \/ (v.act # "block" /\ inDisk /\ blind))
          /\ falseBlock' = (falseBlock \/ (v.act = "block" /\ exact))
          /\ IF v.act # "block" /\ lands
               THEN /\ disk' = [l \in 1..Len(disk) |->
                                   IF tg <= l /\ l <= tg + span - 1 THEN new[l - tg] ELSE disk[l]]
                    /\ rev' = rev + 1 /\ tok' = tok + span
                    /\ know' = [l \in Lines |-> IF lo <= l /\ l <= hi THEN new[l - lo] ELSE know[l]]
                    /\ reads' = relocRead
                    /\ lastEditOk' = TRUE
                    /\ pc' = "editRW"
                    /\ pend' = [k |-> "edit", lo |-> tg, hi |-> tg + span - 1, reloc |-> (v.act = "reloc"),
                                own |-> ~oldText,
                                toks |-> [l \in Lines |-> IF tg <= l /\ l <= tg + span - 1
                                                          THEN new[l - tg] ELSE 0]]
                    /\ mutatedTurn' = TRUE
               ELSE /\ UNCHANGED <<disk, rev, tok, know, pend, mutatedTurn>>
                    /\ reads' = IF v.act # "block" THEN relocRead ELSE reads
                    /\ lastEditOk' = (v.act # "block")
                    /\ pc' = "idle"
    /\ ops' = ops + 1
    /\ UNCHANGED <<kTurn, ft, written, pendCreate, born, turnNo, ext, nb, fixedTurn, dr>>

\* tool_result of the edit: recordWritten (FileTime from disk now).
EditRW ==
    /\ pc = "editRW"
    /\ ft' = rev /\ written' = Auth(disk) /\ pendCreate' = FALSE
    /\ reads' = LET r0 == IF pendCreate
                            THEN AddRec(reads, Rec(1, Len(disk), MkH(disk, 1, Len(disk)), FALSE), TRUE)
                            ELSE reads
                IN IF RecordOwnEdit /\ pend.own /\ (~pend.reloc \/ ~OwnEditSkipsReloc)
                     THEN Append(r0, Rec(pend.lo, pend.hi,
                                         [l \in Lines |-> IF Hashes THEN pend.toks[l] ELSE 0], FALSE))
                     ELSE r0
    /\ pc' = "idle" /\ pend' = [k |-> "none"]
    /\ UNCHANGED <<disk, rev, tok, know, kTurn, lastEditOk, born, turnNo, ops, ext,
                   nb, fixedTurn, mutatedTurn, dr, staleAllow, blindAllow, falseBlock>>

\* ---- write (whole file) ----
Write ==
    /\ CanOp("write")
    /\ LET c == [l \in 1..N0 |-> tok + l - 1]
       IN /\ disk' = c /\ know' = KnowAll(c)
          /\ pend' = [k |-> "write", c |-> KnowAll(c), n |-> N0]
    /\ rev' = rev + 1 /\ tok' = tok + N0
    /\ pendCreate' = TRUE                              \* noteCreatedFile at tool_call
    /\ pc' = "writeRW1" /\ ops' = ops + 1 /\ mutatedTurn' = TRUE
    /\ UNCHANGED <<kTurn, reads, ft, written, lastEditOk, born, turnNo, ext, nb,
                   fixedTurn, dr, staleAllow, blindAllow, falseBlock>>

\* recordWritten before the pipeline: stamps FileTime, injects the creation read.
WriteRW1 ==
    /\ pc = "writeRW1"
    /\ ft' = rev /\ written' = Auth(disk) /\ pendCreate' = FALSE
    /\ reads' = IF pendCreate
                  THEN AddRec(reads, Rec(1, IF CreationHandlerEvidence THEN Len(disk) ELSE pend.n,
                                         IF CreationHandlerEvidence THEN MkH(disk, 1, Len(disk))
                                         ELSE MkH(pend.c, 1, pend.n), FALSE), TRUE)
                  ELSE reads
    /\ pc' = IF FixKind # "none" /\ ~fixedTurn THEN "fix" ELSE "idle"
    /\ pend' = IF FixKind # "none" /\ ~fixedTurn THEN pend ELSE [k |-> "none"]
    /\ UNCHANGED <<disk, rev, tok, know, kTurn, lastEditOk, born, turnNo, ops, ext,
                   nb, fixedTurn, mutatedTurn, dr, staleAllow, blindAllow, falseBlock>>

\* The turn's first write: immediate autofix rewrites line 1.
Fix ==
    /\ pc = "fix"
    /\ fixedTurn' = TRUE
    /\ IF ModOk(FixKind, disk, 1)
         THEN /\ disk' = Mod(FixKind, disk, 1, tok) /\ rev' = rev + 1 /\ tok' = tok + 1
              /\ pc' = "writeRW2"
              /\ pend' = [k |-> "fixed", c |-> KnowAll(Mod(FixKind, disk, 1, tok)),
                          n |-> Len(Mod(FixKind, disk, 1, tok))]
         ELSE /\ UNCHANGED <<disk, rev, tok>> /\ pc' = "idle" /\ pend' = [k |-> "none"]
    /\ UNCHANGED <<know, kTurn, guardVars, ops, ext, nb, mutatedTurn, staleAllow, blindAllow, falseBlock>>

\* recordWritten after the pipeline; the tool result attaches the post-fix bytes.
WriteRW2 ==
    /\ pc = "writeRW2"
    /\ ft' = rev /\ written' = Carry(disk)
    /\ know' = pend.c
    /\ reads' = IF RecordAuthoritative
                  THEN AddRec(reads, Rec(1, pend.n, MkH(pend.c, 1, pend.n), FALSE), TRUE)
                  ELSE reads
    /\ pc' = "idle" /\ pend' = [k |-> "none"]
    /\ UNCHANGED <<disk, rev, tok, kTurn, pendCreate, lastEditOk, born, turnNo, ops,
                   ext, nb, fixedTurn, mutatedTurn, dr, staleAllow, blindAllow, falseBlock>>

\* ---- recognized bash write (whole file, no creation read) ----
\* handleToolResult's recognized-bash arm: recordWritten(stampFileTime: false)
\* (#3525). The command text is in the conversation, so the agent knows what it
\* wrote (know), but no creation read is injected and FileTime stays where it
\* was. With no read record this is the authorship the zero-read arm of Verdict
\* alone vouches for: the no-drop witness of #3520 (BashAuthored.cfg).
BashWrite ==
    /\ CanOp("bash")
    /\ LET c == [l \in 1..N0 |-> tok + l - 1]
       IN /\ disk' = c /\ know' = KnowAll(c)
          /\ written' = IF Broken THEN Retired ELSE Auth(c)
    /\ rev' = rev + 1 /\ tok' = tok + N0
    /\ ops' = ops + 1 /\ mutatedTurn' = TRUE
    /\ UNCHANGED <<kTurn, reads, ft, pendCreate, lastEditOk, born, turnNo, pc, pend, ext, nb,
                   fixedTurn, dr, staleAllow, blindAllow, falseBlock>>

\* ---- a recognized bash write of one line ("pbash": sed -i on line 1) ----
\* The agent knows the line it wrote, not the rest. Scoped to a file this
\* conversation already authored (the #4187 F6 shape: an own write after
\* another writer's); a first partial write of a never-read file is the
\* whole-file BashWrite abstraction above (#3520), not modelled here.
PartialBashWrite ==
    /\ CanOp("pbash") /\ written.on
    /\ disk' = Replace(disk, 1, tok) /\ know' = [know EXCEPT ![1] = tok]
    /\ written' = IF Broken THEN Retired ELSE Auth(Replace(disk, 1, tok))
    /\ rev' = rev + 1 /\ tok' = tok + 1
    /\ ops' = ops + 1 /\ mutatedTurn' = TRUE
    /\ UNCHANGED <<kTurn, reads, ft, pendCreate, lastEditOk, born, turnNo, pc, pend, ext, nb,
                   fixedTurn, dr, staleAllow, blindAllow, falseBlock>>

\* ---- a mutation-bridge write of one line ("bridge") ----
\* The write with NO pre-write check of its own: a co-process producer's
\* recordMutation after the fact (stampLiveMutation's
\* recordWritten(advanceAuthorship: false, stampFileTime: false)), a
\* server-initiated workspace/applyEdit, and a drain record that reaches the
\* guard unlicensed (an advanceAuthorship: true write whose tool_call checked
\* no path, so wasCheckedAtCall refuses it). Nothing ran before the write, so
\* the authorship it lands on cannot be checked against the bytes it wrote
\* around: it may create a first authorship and otherwise ends one. The agent
\* is told what was written (know), so the only hazard left is the other
\* writer's bytes. Scoped to an authored file like PartialBashWrite: a first
\* record is the #3865 credit. The owned in-process writers that used to be
\* listed here (ast_grep_replace, an LSP edit, the observed replay) carry a
\* tool_call since #4187 round 5 and are OwnCall/OwnWrite below; the settled
\* sweep's replay stays here, unlicensed.
BridgeWrite ==
    /\ CanOp("bridge") /\ written.on
    /\ LET c == Replace(disk, 1, tok)
       IN /\ disk' = c /\ know' = [know EXCEPT ![1] = tok]
          /\ written' = IF ~BridgeNoAdvance THEN Auth(c)
                        ELSE IF written.c = c THEN written ELSE Retired
    /\ rev' = rev + 1 /\ tok' = tok + 1
    /\ ops' = ops + 1 /\ mutatedTurn' = TRUE
    /\ UNCHANGED <<kTurn, reads, ft, pendCreate, lastEditOk, born, turnNo, pc, pend, ext, nb,
                   fixedTurn, dr, staleAllow, blindAllow, falseBlock>>

\* #4210 Q4: settled-sweep drift has no conversation-owned bytes. The fixed
\* bridge therefore leaves a first credit absent; the mutant re-baselines the
\* whole file and lets the later positional edit pass.
SettledWrite ==
    /\ CanOp("settle") /\ ~written.on
    /\ disk' = Replace(disk, 1, tok) /\ know' = [know EXCEPT ![1] = tok]
    /\ written' = IF BridgeNoAdvance THEN NoAuth ELSE Auth(disk')
    /\ rev' = rev + 1 /\ tok' = tok + 1 /\ ops' = ops + 1 /\ mutatedTurn' = TRUE
    /\ UNCHANGED <<kTurn, reads, ft, pendCreate, lastEditOk, born, turnNo, pc, pend, ext, nb,
                   fixedTurn, dr, staleAllow, blindAllow, falseBlock>>

\* ---- an owned in-process write ("own"): retire at tool_call, advance at the write ----
\* #4187 R4-1/R4-2: a pi-lens-owned in-process tool (ast_grep_replace over the
\* file it named, an lsp_navigation rename, lens_diagnostic_mark's suppress) has
\* a tool_call seam before its write, and the guard licenses an advance per
\* call for the paths that call checked (ReadGuard.noteCheckedPaths). Two
\* actions, because the license is checked at the call and spent at the write,
\* and External may land in between (ExtPhases "inflight"): that window is the
\* code's own (R4-6, a foreign write while the tool runs) and AuthorOwnToctou.cfg
\* states it. Scoped to an authored file like BridgeWrite: a first credit is the
\* #3865 credit and is not modelled here.
OwnCall ==
    /\ CanOp("own") /\ written.on
    /\ written' = IF Broken THEN Retired ELSE [written EXCEPT !.lic = TRUE]
    /\ pc' = "ownpending" /\ ops' = ops + 1
    /\ UNCHANGED <<disk, rev, tok, know, kTurn, reads, ft, pendCreate, lastEditOk,
                   born, turnNo, pend, ext, nb, fixedTurn, mutatedTurn, dr,
                   staleAllow, blindAllow, falseBlock>>

\* The write and its licensed advance: recordWritten(advanceAuthorship: true,
\* toolCallId) for a path the call licensed. No op is consumed: this is the
\* second half of the one call OwnCall counted.
OwnWrite ==
    /\ pc = "ownpending"
    /\ LET c == Replace(disk, 1, tok)
       IN /\ disk' = c /\ know' = [know EXCEPT ![1] = tok]
          /\ written' = [Auth(c) EXCEPT !.lic = ~SpendLicense]
    /\ rev' = rev + 1 /\ tok' = tok + 1 /\ mutatedTurn' = TRUE /\ pc' = "idle"
    /\ UNCHANGED <<kTurn, reads, ft, pendCreate, lastEditOk, born, turnNo, pend, ops, ext,
                   nb, fixedTurn, dr, staleAllow, blindAllow, falseBlock>>

\* A second record under the settled call id. It must not advance after the
\* first OwnWrite consumed the license; SpendLicense = FALSE is the
\* compile-valid reusable-license mutant.
OwnWriteAgain ==
    /\ CanOp("ownagain") /\ written.on
    /\ LET c == Replace(disk, 1, tok)
       IN /\ disk' = c /\ know' = [know EXCEPT ![1] = tok]
          /\ written' = IF written.lic
                         THEN IF SpendLicense
                              THEN [Auth(c) EXCEPT !.lic = FALSE]
                              ELSE Auth(c)
                         ELSE Retired
    /\ rev' = rev + 1 /\ tok' = tok + 1 /\ mutatedTurn' = TRUE
    /\ UNCHANGED <<kTurn, reads, ft, pendCreate, lastEditOk, born,
                   turnNo, pc, pend, ops, ext, nb, fixedTurn, dr,
                   staleAllow, blindAllow, falseBlock>>

\* Round 4's code, the R4-1 mutant: the record advanced EVERY path the write
\* changed, licensed or not, so a rename's importers, an ast-grep folder and a
\* server-initiated applyEdit all re-baselined an authorship over bytes nothing
\* checked. In this single-file model that is an own write no call checked, so
\* it is its own op kind: a config selects "ownwrite" instead of the "own" pair.
OwnWriteUnchecked ==
    /\ CanOp("ownwrite") /\ written.on
    /\ LET c == Replace(disk, 1, tok)
       IN /\ disk' = c /\ know' = [know EXCEPT ![1] = tok]
          /\ written' = Auth(c)
    /\ rev' = rev + 1 /\ tok' = tok + 1 /\ ops' = ops + 1 /\ mutatedTurn' = TRUE
    /\ UNCHANGED <<kTurn, reads, ft, pendCreate, lastEditOk, born, turnNo, pc, pend,
                   ext, nb, fixedTurn, dr, staleAllow, blindAllow, falseBlock>>

----------------------------------------------------------------------------
\* Another writer (external editor, second pi-lens instance, git checkout).
External ==
    /\ ext < ExtWrites
    /\ (IF pc = "idle" THEN "idle" ELSE "inflight") \in ExtPhases
    /\ \E kind \in ExtKinds, l \in 1..MaxLen :
         /\ ModOk(kind, disk, l)
         /\ disk' = Mod(kind, disk, l, tok)
    /\ rev' = rev + 1 /\ tok' = tok + 1 /\ ext' = ext + 1
    /\ UNCHANGED <<know, kTurn, guardVars, pc, pend, ops, nb, fixedTurn, mutatedTurn,
                   staleAllow, blindAllow, falseBlock>>

Delivered(r) == ~r.prov

\* A settle drain is due: the run wrote, and agent_settled has not queued it yet.
SettleDue == DrainMode # "atomic" /\ FormatDrain # "none" /\ mutatedTurn

\* A user turn boundary: agent_end's deferred format drain, then the next prompt.
\* Since #4185 round 3 (BlockRelease # "none") it also drops every capture
\* still held (handleAgentEnd, ReadGuard.dropProvisionalReads).
\* With DrainMode # "atomic" the drain is queued at Settle instead and lands
\* in Drain, which the conversation can have moved past.
Turn ==
    /\ Idle /\ "turn" \in Bounds /\ nb < MaxBounds /\ ~SettleDue
    /\ IF DrainMode = "atomic" /\ FormatDrain # "none" /\ mutatedTurn /\ ModOk(FormatDrain, disk, 1)
         THEN /\ disk' = Mod(FormatDrain, disk, 1, tok) /\ rev' = rev + 1 /\ tok' = tok + 1
              /\ written' = IF Broken THEN Retired              \* recordWritten after the format
                             ELSE Carry(Mod(FormatDrain, disk, 1, tok))
              /\ ft' = IF FormatStamp THEN rev + 1 ELSE ft
         ELSE UNCHANGED <<disk, rev, tok, ft, written>>
    /\ reads' = IF BlockRelease # "none" THEN SelectSeq(reads, Delivered) ELSE reads
    /\ kTurn' = know /\ turnNo' = turnNo + 1
    /\ fixedTurn' = FALSE /\ mutatedTurn' = FALSE /\ nb' = nb + 1
    /\ UNCHANGED <<know, pendCreate, lastEditOk, born, pc, pend, ops, ext, dr,
                   staleAllow, blindAllow, falseBlock>>

\* agent_settled (#3521 review F1): the run is over but the next prompt has not
\* come, and pi already accepts /tree. The drain for this turn's writes is
\* queued with the branch epoch it captured. pi marks the run inactive and
\* then invokes the handlers, so pi-lens's handler captures the epoch before
\* any /tree can land (SettleDue gates the boundaries below); an earlier
\* extension's handler that awaits first is not modelled (README Limits).
\* Requeued work is drained by the next settle, whenever it comes. "fenced"
\* keeps the epoch the work was queued with, unless this branch wrote the file
\* again (mutatedTurn): the merged record then carries the newer epoch.
Settle ==
    /\ Idle /\ (SettleDue \/ dr.rq) /\ ~dr.q
    /\ dr' = [dr EXCEPT !.q = TRUE, !.rq = FALSE,
                        !.ep = IF DrainMode = "fenced" /\ dr.rq /\ ~mutatedTurn
                                 THEN dr.ep ELSE dr.cur]
    /\ mutatedTurn' = FALSE
    /\ UNCHANGED <<disk, rev, tok, know, kTurn, reads, ft, written, pendCreate, lastEditOk,
                   born, turnNo, pc, pend, ops, ext, nb, fixedTurn,
                   staleAllow, blindAllow, falseBlock>>

\* The queued drain lands: the formatter rewrites line 1, then recordWritten.
\* "fenced" refuses the stamp when a /tree bumped the epoch since Settle.
Drain ==
    /\ Idle /\ dr.q
    /\ dr' = [dr EXCEPT !.q = FALSE]
    /\ IF ModOk(FormatDrain, disk, 1)
         THEN /\ disk' = Mod(FormatDrain, disk, 1, tok) /\ rev' = rev + 1 /\ tok' = tok + 1
              /\ IF DrainMode = "unfenced" \/ dr.ep = dr.cur
                   THEN /\ written' = IF Broken THEN Retired
                                      ELSE Carry(Mod(FormatDrain, disk, 1, tok))
                        /\ ft' = IF FormatStamp THEN rev + 1 ELSE ft
                   ELSE UNCHANGED <<ft, written>>
         ELSE UNCHANGED <<disk, rev, tok, ft, written>>
    /\ UNCHANGED <<know, kTurn, reads, pendCreate, lastEditOk, born, turnNo, pc, pend,
                   ops, ext, nb, fixedTurn, mutatedTurn, staleAllow, blindAllow, falseBlock>>

\* An aborted or failed drain puts its work back without writing (#3521
\* round-2 verify R2-F1): ESC, a formatter or autofix failure, missing
\* clients. pi's /tree awaits abort() first, so an aborted settle then a
\* /tree is the common order.
Requeue ==
    /\ Idle /\ dr.q
    /\ dr' = [dr EXCEPT !.q = FALSE, !.rq = TRUE]
    /\ UNCHANGED <<disk, rev, tok, know, kTurn, reads, ft, written, pendCreate, lastEditOk,
                   born, turnNo, pc, pend, ops, ext, nb, fixedTurn, mutatedTurn,
                   staleAllow, blindAllow, falseBlock>>

FreshGuard ==
    /\ ft' = -1 /\ written' = NoAuth /\ pendCreate' = FALSE /\ lastEditOk' = FALSE
    /\ born' = rev

\* /new: fresh guard, empty conversation.
New ==
    /\ Idle /\ "new" \in Bounds /\ nb < MaxBounds /\ ~SettleDue
    /\ reads' = <<>> /\ FreshGuard /\ UNCHANGED turnNo
    /\ know' = [l \in Lines |-> 0] /\ kTurn' = know'
    /\ nb' = nb + 1 /\ fixedTurn' = FALSE /\ mutatedTurn' = FALSE
    /\ dr' = [dr EXCEPT !.q = FALSE, !.rq = FALSE]   \* the session generation drops the old drain (#3528)
    /\ UNCHANGED <<disk, rev, tok, pc, pend, ops, ext, staleAllow, blindAllow, falseBlock>>

\* /fork: the conversation restarts before the current prompt (kTurn).
\* BranchFilter (#3521): the fork keeps the records made before the point,
\* whole, with no FileTime stamp (importBranch). Otherwise the candidates the
\* switches name: import the parent's read-set reconciled against disk only
\* (ForkImport), or nothing (the code before #3521).
Kept(S) == SelectSeq(S, AllHashesMatch)
BeforePrompt(r) == r.g < turnNo
\* retainBranch / importBranch keep a record iff its toolCallId is a toolResult
\* on the new branch. A delivered record's is; a provisional record has none
\* (it showed the agent nothing), unless ProvisionalCredit (#4185 round 1).
OnBranch(r) == BeforePrompt(r) /\ (~r.prov \/ ProvisionalCredit)
Fork ==
    /\ Idle /\ "fork" \in Bounds /\ nb < MaxBounds /\ ~SettleDue
    /\ IF BranchFilter
         THEN /\ reads' = SelectSeq(reads, OnBranch)
              /\ ft' = -1
         ELSE LET src == IF ForkAtBoundary THEN SelectSeq(reads, BeforePrompt) ELSE reads
                  imp == IF ForkImport THEN Kept(src) ELSE <<>>
              IN /\ reads' = imp
                 /\ ft' = IF Len(imp) > 0 THEN rev ELSE -1      \* recordRead stamps FileTime
    /\ UNCHANGED turnNo
    /\ written' = KeptAuth /\ pendCreate' = FALSE /\ lastEditOk' = FALSE /\ born' = rev
    /\ know' = kTurn
    /\ nb' = nb + 1 /\ fixedTurn' = FALSE /\ mutatedTurn' = FALSE
    /\ dr' = [dr EXCEPT !.q = FALSE, !.rq = FALSE]   \* the session generation drops the old drain (#3528)
    /\ UNCHANGED <<disk, rev, tok, kTurn, pc, pend, ops, ext, staleAllow, blindAllow, falseBlock>>

\* /tree: the conversation moves to an earlier point in the same activation.
\* BranchFilter (#3521, retainBranch): keep the branch's records whole, clear
\* the FileTime stamp (so each kept record passes the per-line hash rescue),
\* writtenThisSession, pending creations and the edit history, and (only under
\* MtimeAuthored, the code before #3520) re-anchor the mtime fallback. Without
\* it (the code before #3521), no handler.
Tree ==
    /\ Idle /\ "tree" \in Bounds /\ nb < MaxBounds /\ ~SettleDue
    /\ know' = kTurn
    /\ IF BranchFilter
         THEN /\ reads' = SelectSeq(reads, OnBranch)
              /\ ft' = -1 /\ written' = KeptAuth /\ pendCreate' = FALSE
              /\ lastEditOk' = FALSE /\ born' = rev
              /\ dr' = [dr EXCEPT !.cur = dr.cur + 1]      \* the branch epoch
         ELSE /\ reads' = IF ForkAtBoundary THEN SelectSeq(reads, BeforePrompt) ELSE reads
              /\ written' = IF ForkAtBoundary THEN NoAuth ELSE written   \* writtenThisSession
              /\ UNCHANGED <<ft, pendCreate, lastEditOk, born, dr>>
    /\ UNCHANGED turnNo
    /\ nb' = nb + 1
    /\ UNCHANGED <<disk, rev, tok, kTurn,
                   pc, pend, ops, ext, fixedTurn, mutatedTurn,
                   staleAllow, blindAllow, falseBlock>>

Next ==
    \/ \E lo \in 1..MaxLen, hi \in 1..MaxLen : ReadCall(FALSE, lo, hi)
    \/ ReadCall(TRUE, 1, MaxLen)
    \/ ReadExec \/ ReadResult \/ FailedRead \/ BlockedReadCall \/ BlockedReadEnd
    \/ \E lo \in 1..MaxLen, s \in Spans, o \in BOOLEAN : Edit(lo, s, o)
    \/ EditRW
    \/ Write \/ WriteRW1 \/ Fix \/ WriteRW2 \/ BashWrite \/ PartialBashWrite \/ BridgeWrite \/ SettledWrite
    \/ OwnCall \/ OwnWrite \/ OwnWriteAgain \/ OwnWriteUnchecked
    \/ External \/ Turn \/ Settle \/ Requeue \/ Drain \/ New \/ Fork \/ Tree

Spec == Init /\ [][Next]_vars

----------------------------------------------------------------------------
\* False allow: an allowed (or relocated) positional edit of lines the agent
\* was shown lands on lines whose current content is what it was shown.
NoStaleAllow == ~staleAllow

\* False allow: an edit of lines this conversation never showed the agent is
\* refused (with contextLines > 0 the guard admits +-Ctx lines by design).
NoBlindAllow == ~blindAllow

\* False block: with hashes available, an edit whose target lines hold
\* exactly what the agent was shown is never refused.
NoFalseBlock == ~falseBlock
=============================================================================
