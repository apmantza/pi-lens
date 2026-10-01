# Read-guard model

A TLA+ model of the read-before-edit guard (`clients/read-guard.ts` `checkEdit`) for one
file. It covers the agent's reads and edits, pi-lens' own writes (the
immediate autofix, the deferred `agent_end` format), another writer, and
session boundaries. The `TLA+ models` CI job
(`node scripts/check-tla-models.mjs`) checks every config here against its
`\* expect:` line.

Issues: #3519, #3521, #3522, #3523, #3524 and #3525 are fixed in the code and
modelled as such. The configs for #3520 still document its bug against the
current code (`violated`).

## Scope

The model covers **positional** edits: `oldRange`, `edits[].range`, and the
hashline adapters. The guard fully enforces only this class. An `oldText` edit
is content-validated by the host, so `checkEdit` gets `skipSnapshotCheck` and
`oldTextResolved` (`clients/runtime-tool-call.ts` `handleToolCall`). For such an edit, FileTime and
the snapshot are skipped and out-of-range is only a warning. The only checks
left are zero-read and the bridge content binding.

A file is a sequence of line tokens. Every write mints fresh tokens, so token
equality is `lineContentHash` equality. A whitespace-only rewrite counts as no
change.

## Actors

- **The agent**, one tool at a time (pi awaits each handler):
  - **read** (full or ranged): the tool_call provisional record, which takes
    a FileTime stamp (`clients/runtime-tool-call.ts` `handleToolCall`), the host read, then the
    tool_result record that supersedes it (`clients/runtime-tool-result.ts` `handleToolResult`).
    Since #3524, when the file moved after the tool_call's stamp, that record
    is hashed and sized from the delivered text and keeps the stamp;
  - **positional edit** of 1 or 2 lines: `checkEdit` at tool_call,
    optional relocation, the host apply, then `recordWritten` at
    tool_result. Since #3523, an edit the guard allowed unrelocated
    (`markToolCallEditInPlace`) is recorded as a read of the lines it
    wrote, hashed from its `newText` (`clients/runtime-tool-result.ts`
    `handleToolResult`). Only a
    single `edits[].range` replacement is recorded (#3760): a multi-range
    batch, an `oldRange` edit and a hashline edit keep being refused on a
    re-edit, and a relocated edit is never recorded (`OwnEditRelocInsert`);
  - **write**: `noteCreatedFile` at tool_call, the host write, and
    `recordWritten`, which injects the creation read (`read-guard.ts`
    `injectCreationRead`). Since #3524's remainder it is hashed from the
    write's executed `content`, not from disk. The turn's first write then
    runs the immediate autofix (`clients/pipeline.ts` `runAutofix`), calls `recordWritten` again
    (`clients/runtime-tool-result.ts` `handleToolResult`), and attaches the post-fix bytes as
    "authoritative". Since #3519 the attachment, when delivered, is
    recorded as a whole-file read hashed from the attached bytes.
- **Another writer** (an external editor, a second pi-lens instance, git):
  changes the file between any two steps. With `ExtPhases` it can land inside
  a tool call.
- **The deferred `agent_end` format drain**: rewrites the file, then calls
  `recordWritten` (`clients/runtime-agent-end.ts` `handleAgentEnd`). Since #3525 that call credits
  authorship (`written`) and leaves FileTime where it was
  (`stampFileTime: false`): the agent never saw those bytes. The format
  service's own FileTime is its own table (`format-service.ts`, keyed
  `<session>:format`) since #3785 review round 2. Before that it was built
  with the guard's session id, and a `FileTime` is keyed by session id, so
  its stamp before formatting (`pipeline.ts` `runFormatPhase`) and after
  (`FormatService.formatFile`) landed in the guard's table: production
  was `FormatStamp = TRUE` (`UnhashedFormatStampOn`) even with
  `stampFileTime: false`. With `DrainMode = "atomic"` it
  runs inside the turn boundary. Otherwise it is queued at `Settle` (pi's
  `agent_settled`, when pi already accepts `/tree`) and lands in `Drain`,
  possibly after a `/tree`, or an aborted or failed drain puts it back
  (`Requeue`) for the next settle. `"unfenced"` credits its
  `recordWritten`. `"settle"` (#3521 round 2) refuses it once a `/tree`
  moved the branch since the settle that dequeued it, so requeued work is
  credited to the new branch. `"fenced"` (the code since #3521 round 3)
  refuses it against the epoch the work was queued with, which `Requeue`
  keeps; a new write on the current branch merges into the newer epoch.
- **Boundaries**:
  - user turn;
  - `/new` (a fresh guard);
  - `/fork` (a fresh guard in a new activation; pi forks *before* a chosen
    user message, so the conversation loses everything after it);
  - `/tree` (the conversation moves inside the same activation).

  Since #3521 (`BranchFilter`), both keep exactly the records whose tool
  result is on the new branch, each whole, and clear the FileTime stamp,
  `writtenThisSession`, pending creations and the edit history, and
  re-anchor the mtime fallback (`read-guard.ts` `retainBranch` /
  `importBranch`, `index.ts` `session_tree` and `session_start`). Before it,
  `/fork` imported nothing (pi re-runs the extension factory, so the
  closure-local stash died) and `/tree` had no handler.

`know` is what the conversation has shown the agent: read results, its own
edits and writes, and the authoritative attachment.

## Switches

The current code is `HandlerEvidence = FALSE`, `CreationHandlerEvidence =
FALSE`, `RecordAuthoritative = TRUE`, `RecordOwnEdit = TRUE`,
`OwnEditSkipsReloc = TRUE`, `MtimeAuthored = TRUE`, `OwnEditRescue = FALSE`,
`BranchFilter = TRUE`, `FormatStamp = FALSE`, `SpanSnapshot = TRUE`,
`RelocFromLatest = TRUE`, `WholeVouchesPastEnd = FALSE`, `ForkAtBoundary = FALSE`,
`DrainMode = "fenced"` (every config before #3521 round 2 keeps `"atomic"`,
its old shape). `ForkImport` is read only when `BranchFilter = FALSE`; the code before #3521
was `ForkImport = FALSE` (the fork imported nothing), not `TRUE` as this file
used to say. `SuppressByNewerContext` (`TRUE` before #3522) is read only when
`SpanSnapshot = FALSE`, so every config sets `SpanSnapshot = TRUE` and its value
is inert. `WholeVouchesPastEnd` (#3522 part 3, a whole-file view also vouching
that lines past its end do not exist) is not in the code, and no invariant
needs it.
A config that turns one of these off either names the bug it isolates (for
example `MtimeAuthored = FALSE` in `Guarded`, so bug 2 does not mask the rest)
or is a mutant of a fix (`*NoRecord`, `EvidenceAtResultHandler`,
`OwnEditRelocInsertRecorded`, `SpanSnapshotFixAnyReloc`, `SpanSnapshotFixNoOwnRecord`).

## Guard (as coded)

The model follows `checkEdit` step by step:

- **Zero-read.** `wasWrittenThisSession`: `writtenThisSession`, or
  `mtime >= sessionStartMs`.
- **FileTime.** Whole-file mtime/ctime/size. The rescue is
  `canIgnoreStalenessByHashes` (`canTreatStalenessAsOwnPriorEdit` is gone
  since #3525).
- **Coverage.** `checkCoverage`: the union of non-provisional ranges, widened
  by `contextLines`.
- **Snapshot.** `validateRangeSnapshot`: each line of the range against the
  newest non-provisional read that delivered it (`newestViewOfLine`, the
  effective range, never the `contextLines` zone). Since #3522, before it a
  context-widened candidate that covered the whole range, and the "a newer
  unavailable candidate cancels the mismatch" rule. The model treats a read
  without hashes as delivering nothing, and the code as delivering a line it
  cannot check; the two agree because `Hashes` is global here.
- **FileTime rescue.** `canIgnoreStalenessByHashes` asks the same per-line
  question (`HashRescue`).
- **Relocation.** `findRelocation`: only from the read that is the newest view
  of every line of the range (`RelocFromLatest`), which must match uniquely.

## Invariants

| Invariant | Promise |
|---|---|
| `NoStaleAllow` | An allowed or relocated edit of lines the agent was shown lands on lines that still hold what it was shown. `read-guard.ts` header items 2-3; `importBranch` never re-hashes a record from today's disk. |
| `NoBlindAllow` | An edit of lines this conversation never showed the agent is refused. Header item 1, "Read state from session 1 never authorises session 2". With `contextLines > 0` the guard admits ±contextLines by design (`ContextSlack`). |
| `NoFalseBlock` | With hashes, an edit whose target lines hold exactly what the agent was shown is never refused. The attachment is "authoritative for subsequent edits". `recordWritten` exists so an own write "doesn't trigger file_modified". |

`NoStaleAllow` and `NoFalseBlock` are the two directions of catalog shape 54:
a record built from the conversation's bytes must neither pass a stale edit
nor refuse an exact one.

## Results

TLC 2.19 (`tla2tools.jar` v1.7.4), `-workers auto`. Times were measured on a
loaded machine (load average about 6-8 on 4 cores): 80 s for the 30 configs
before #3521 (82 s wall at `-workers 2`), `NewSession` the slowest at 14 s.
With #3521's eight configs and the deterministic `-workers 1` (#3517), the
36 configs took 164 s one after another at load average about 4-6; the
#3521 configs were 56 s of that, `TreeFilterExt` the slowest at 21 s. The
three drain configs of #3521 round 2 took 13 s, 4 s and 4 s at load average
about 45.

`Guarded` runs at three agent ops to fit CI's `TLA+ models` budget (#3572).
At three ops, every mutant keeps its verdict and the #3523 flip still flips.
The four-op interleaving (for example two reads and two edits) was checked
only once, at the old bound: it passed with 969,664 distinct states on the
head that added this model. It is not checked in CI.

| Config | Models | Expect | Distinct states |
|---|---|---|---|
| `AutofixFalseBlock` | #3519 fixed: a one-line edit of the attached content | pass | 19 |
| `AutofixFalseBlockNoRecord` | the same without the attachment record (the code before #3519) | violated `NoFalseBlock` | 12 |
| `AutofixRelocate` | #3519 fixed: a two-line edit of the attached content | pass | 19 |
| `AutofixRelocateNoRecord` | the same without the attachment record | violated `NoStaleAllow` | 13 |
| `AutofixRecorded` | #3519 fixed, another writer anywhere, 1- and 2-line edits | pass | 334 |
| `AutofixRecordedNoRecord` | the same without the attachment record | violated `NoFalseBlock` | 105 |
| `AutofixPastEnd` | an older creation read still covers a line past the attachment's end: the per-line rule refuses it (#3522 part 3 needs no code) | pass | 23 |
| `OwnReEdit` | #3523 fixed: the agent re-edits a line it just wrote | pass | 2,036 |
| `OwnReEditNoRecord` | the same without the own-edit record (the code before #3523) | violated `NoFalseBlock` | 327 |
| `OwnEditReloc` | #3523 fixed: a relocated edit is not recorded; write + autofix, an other-writer insert, a relocated edit, then an edit | pass | 1,608 |
| `OwnEditRelocInsert` | #3760: ranged reads, another writer's insert, an own edit, a relocated two-line edit, then an edit at the agent's numbering; the relocated edit is not recorded | pass | 609,580 |
| `OwnEditRelocInsertRecorded` | the same with the relocated edit recorded at the lines it wrote: the next edit passes on the wrong line of the agent's own text | violated `NoStaleAllow` | 39,157 |
| `EvidenceAtResult` | #3524 fixed: another writer lands between the host read and the tool_result | pass | 23,571 |
| `EvidenceAtResultHandler` | the same with the read taken from disk at tool_result (the code before #3524) | violated `NoStaleAllow` | 316 |
| `EvidenceFromDelivered` | #3524 fixed, another writer anywhere, replace/delete/insert | pass | 93,904 |
| `CreationAtResult` | #3524 remainder fixed: the injected creation read is hashed from the write's content | pass | 1,592 |
| `CreationAtResultHandler` | the same hashed from disk at tool_result (the code before it) | violated `NoStaleAllow` | 907 |
| `Guarded` | current code, reads, one-line edits, another writer between tool calls, three agent ops (#3572) | pass (all three invariants) | 69,531 |
| `GuardedNoCoverage` / `GuardedNoSnapshot` | `Guarded` without `checkCoverage` / `validateRangeSnapshot` | violated `NoBlindAllow` / `NoStaleAllow` | 100 / 3,830 |
| `NewSession` | current code across `/new` | pass | 316,790 |
| `Unhashed` / `UnhashedNoFileTime` | current code without line hashes / without FileTime | pass / violated `NoStaleAllow` | 13,370 / 243 |
| `ContextSlack` | the admitted `contextLines` slack | violated `NoBlindAllow` | 79 |
| `MtimeAuthored`, `MtimeAuthoredNew` | #3520 | violated `NoBlindAllow` | 9 / 36 |
| `TreeFilter` | #3521 fixed: `/tree` with reads, ranged reads, edits and writes | pass | 50,413 |
| `TreeFilterMtime` | the same with the #3520 mtime fallback on: the re-anchored `born` | pass | 50,413 |
| `TreeFilterExt` | #3521 fixed, another writer anywhere | pass | 344,765 |
| `TreeFilterUnhashed` | #3521 fixed without hashes | pass | 1,174 |
| `TreeCarriesReads` | the same as `TreeFilter`'s base with `BranchFilter = FALSE` (the code before #3521: no handler) | violated `NoBlindAllow` | 337 |
| `ForkFilter` | #3521 fixed: `/fork` | pass | 50,036 |
| `ForkFilterUnhashed` | #3521 fixed at `/fork` without hashes | pass | 1,150 |
| `ForkDropsReads` | `BranchFilter = FALSE`, `ForkImport = FALSE` (the code before #3521: the fork imports nothing) | violated `NoFalseBlock` | 876 |
| `TreeDrainFenced` | #3521 review F1 and R2-F1 fixed: the settle drain lands after a `/tree`, possibly requeued first, and its stamp is refused | pass | 179,312 |
| `TreeDrainRequeue` | the same with the epoch taken at the settle that dequeues it (round 2): requeued work is credited to the new branch | violated `NoBlindAllow` | 15,534 |
| `TreeDrainUnfenced` | the same, stamp credited (the code before round 2) | violated `NoBlindAllow` | 2,529 |
| `TreeDrainFencedMtime` | the fenced drain with the #3520 mtime fallback: the formatter write postdates the re-anchor (residual until #3520) | violated `NoBlindAllow` | 2,528 |
| `ContextSuppress`, `SpanAcrossReads` | #3522 fixed: a newer context-only read, and an edit spanning two reads | pass | 232,543 / 146,000 |
| `SpanSnapshotFix` | #3522 fixed, one- and two-line edits, contextLines 1, another writer (replace/delete/insert), three agent ops | pass | 98,195 |
| `SpanSnapshotFixAnyReloc` | the same relocating from any read that hashes the range | violated `NoStaleAllow` | 24,987 |
| `SpanSnapshotFixNoOwnRecord` | the same without the own-edit read record (the code before #3523, rescue on) | violated `NoStaleAllow` | 6,945 |
| `UnhashedOwnEditRescue`, `UnhashedFormatStamp` | #3525 fixed: no own-edit rescue; the drain credits authorship only | pass | 1,338 / 245 |
| `UnhashedOwnEditRescueOn`, `UnhashedFormatStampOn` | the same with the rescue / the drain's FileTime stamp back (the code before #3525) | violated `NoStaleAllow` | 437 / 101 |

`OwnEditReloc` sets `CreationHandlerEvidence =
FALSE`, so the creation-read race `CreationAtResult` documents cannot mask the
relocation check.

The investigation's configs for the candidate fixes of #3520
(`AllFixes`, `AllFixesCtx`, `NoMtimeAuthored`, `ForkAtBoundary`,
`ForkImportWholeRecord`, `OwnEditRecorded*`) are not here; each arrives with
its fix. #3525's `UnhashedFix` is the flipped `UnhashedOwnEditRescue` and
`UnhashedFormatStamp`; its `OwnEditRescueContext` (the hashed case, a hybrid
with the #3522 fix on) is not added, since `SpanSnapshotFix` now checks
contextLines 1 with another writer and the rescue off. The four-op
`SpanSnapshotFix` (1,676,422 distinct states, 42 s) was checked once, at the
head that added it, and is not in CI.

## Replays

`tests/clients/read-guard-conversation-evidence.test.ts` replays the fixed
configs through the real `handleToolCall` / `handleToolResult`, with pi's real
`read` tool. The case names end with the config they replay, for example
"allows re-editing the line the agent just wrote (OwnReEdit)". The #3522
replays (`ContextSuppress`, `SpanAcrossReads`, `SpanSnapshotFixAnyReloc`) are in
the `#3522` block of the same file.

## Limits

- One file, one agent tool at a time. Parallel batches are not modelled (pi
  runs every `tool_call` of a batch before any tool executes), nor is #3506's
  autofix-versus-concurrent-edit race.
- FileTime detects every write. Real mtime/ctime/size can miss an equal-size
  rewrite inside one timestamp tick.
- No clock. The own-edit rescue (its 120 s window and its same-millisecond
  tie, #3523) and the range-stale 60 s grace it enabled are deleted (#3525);
  `OwnEditRescue = TRUE` models the rescue with its window always open.
- An own edit's `recordWritten` stamps FileTime here (`EditRW`). Since #3525
  the code skips that stamp when FileTime had moved at the edit's check
  (`ReadGuard.fileTimeMoved`, carried as `ToolCallAttribution.fileTimeStale`),
  so the model explores more fresh-FileTime states than the code reaches.
  With `Hashes` global the stamp only decides whether a later edit meets the
  FileTime gate or the per-line gate, and those agree on every allow; it can
  make a relocation reachable, which is content-verified. OldText edits, where
  it decides an allow, are out of scope (above);
  `tests/clients/read-guard-conversation-evidence.test.ts` replays that case
  ("keeps another writer's change stale after an oldText edit passed it
  (R4)").
- Not modelled, and covered by replays in
  `tests/clients/read-guard-conversation-evidence.test.ts` only: R4 (the
  own-edit stamp decided by `fileTimeMoved` at the check; see above), the
  own-edit read's `stampFileTime: false`, the debounce carrying that
  decision (`_ownWriteStamp`), the partial apply's decision taken at its
  preflight, and the settled sweep. Bash writes, LSP rename and code-action
  applies on the direct branch (the no-context bridge fallback still stamps
  until #3865) and the format service credit authorship and leave FileTime:
  for FileTime and hashes that is the model's "another writer", and the
  `written` they add is not modelled for them. The mutation bridge's other
  producers (`observed`, `ast_grep_replace`, co-process extensions) and the
  read bridge still stamp FileTime; they are not modelled either.
- The immediate autofix's `recordWritten` still stamps FileTime (`WriteRW2`),
  including when the attachment was withheld (the agent never saw the
  post-fix bytes). Its unhashed stale allow is a named residual of #3525.
- The attachment record and the `recordWritten` before it are one step here.
  In the code they are separated by the pipeline's analysis; the record
  leaves FileTime to `recordWritten`, which the replays pin.
- Symbol (LSP-expanded) coverage, search-hit credits, bash read spans, the
  bridge `contentBinding`, record and file caps, idle eviction, and
  exemptions are not modelled.
- The host rejects edits past EOF, so the model does not count them.
- The TOCTOU between `checkEdit` at tool_call and the host's positional apply
  is not modelled.
- `/fork` and `/tree` only reach "before the current prompt"
  (`BeforePrompt`, `r.g < turnNo`), and the model's records are matched to
  the branch exactly. The code matches a record to the branch by its tool
  call's `toolResult` on `getBranch()`, which also covers mid-turn targets,
  forward and sibling moves, `/clone` and resume; those are replayed through
  pi's real runtime in `tests/index-3521-fork-tree-witness.test.ts`. The
  accepted residual there, a provider that reuses tool-call ids across
  branches, is not modelled. Clearing the edit history at a move
  (`lastEditOk' = FALSE`) only mattered to the own-edit rescue, which #3525
  deleted.
- `SettleDue` keeps every boundary out until `Settle` has captured the
  branch epoch: pi marks the run inactive and then invokes the
  `agent_settled` handlers, so pi-lens's handler captures before any `/tree`
  can land. An extension whose `agent_settled` handler runs before
  pi-lens's and awaits long enough for a `/tree` breaks that ordering, and
  the drain's stamp is then credited (mutating the gate away violates
  `TreeDrainFenced`). The settled sweep is one more deferred writer with the
  same fence and, since #3525, the same authorship-only `recordWritten`; the
  model's drain stands for both. The actionable-warning quick fix is a third
  (#3676): it acts on report entries, so its work is "queued" when the entry
  is built (its epoch is the entry's, aged to the oldest across a merge), and
  a settle that skips it (a cold LSP) is `Requeue`. Before #3676 it took the
  epoch at the settle that applied it, which is `DrainMode = "settle"`
  (`TreeDrainRequeue`, violated `NoBlindAllow`); since, it is `"fenced"`
  (`TreeDrainFenced`). The oldest-epoch merge and the unstamped-entry case are
  not modelled; both only withhold credit.
