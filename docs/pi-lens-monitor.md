# pi-lens monitor — role contract

Read a LIVE pi-lens session's logs and report what the numbers say, so the
maintainer does not have to. The monitor observes; it never edits code,
never restarts anything, and never touches the session it is reading.

Read first: the engineering principles (`docs/engineering-principles.md`),
then `AGENTS.md` and the defect-shape catalog (`docs/defect-shapes.md`,
especially shape 41: a fixed bound reached at p50 is a design defect), then
`docs/pi-lens-subagent.md` and `docs/pi-lens-investigator.md` for the
forensics conventions this role inherits. This contract adds the standing
readout.

## Memory samples

memory_sample records include bounded attribution fields for diagnosing host
memory growth:

- process.heapUsedBytes is the reading at sample time;
  process.heapSettledBytes is null until a major-GC performance entry, then is
  the latest callback reading; process.heapSettledMajorGcCount makes its age
  visible.
- process.externalNonBufferBytes is externalBytes - arrayBuffersBytes.
- subsystems.persistWorkers.reviewGraph and
  subsystems.persistWorkers.projectSnapshot are the latest asynchronous
  Worker#getHeapStatistics() readings, or null before a worker answers.
- subsystems.treeSitter.treeCacheTotalBytes counts source bytes represented
  by cached trees. Native/WASM growth is attributed by
  process.externalNonBufferBytes; no tree-count estimate is emitted.
- subsystems.wordIndex.wireBytes is the UTF-8 length of the word index's JSON,
  taken natively while the snapshot persist encodes the body, and is null
  until that index's current serialized form is persisted, and again once the
  serialized form is released at `agent_settled` (the `word_index_memo_released`
  row in latency.log records the release and its trigger).
- samplerDurationMs measures the sampler's own record-assembly wall time,
  excluding the surrounding turn.
- idle is false on the periodic sample. It is true on the one sample written
  at a session's first turn start after its own turn end, when that gap is
  longer than the TS idle-evict window (`getLspIdleEvictMs()`, 20 minutes by
  default). That record also carries idleMs, the measured gap. The heap
  reading is process-wide; the gap belongs to the session whose turn started.

All fields are in the existing record and are O(1) reads or latest-value
snapshots; no additional telemetry sink is created.

## Inputs

Read the monitored process's log directory, resolved by `getGlobalPiLensLogDir()`
in `clients/probe-home-state.ts`: a non-empty `PI_LENS_HOME` wins, otherwise
any applicable probe-home redirect, otherwise `~/.pi-lens`. Do not infer this
from the monitor's own environment. The brief names the root. When it does
not, a `PI_LENS_HOME` in the monitored pid's environment (`/proc/<pid>/environ`
on Linux, `ps eww -p <pid>` on macOS) settles it; otherwise a probe-home
redirect may have chosen the root from that process's working directory, so
ask the orchestrator for the root instead of reading `~/.pi-lens`. Pass that directory as `--root` to
`scripts/analyze-pi-lens-logs.mjs`, whose default is `~/.pi-lens`.

- `latency.log` and `extension.log` (JSON lines; every row carries `pid`
  and `ts`). The session is the `pid` the brief names, or the newest pid with
  rows in the last hour when the brief says "live".
- `cascade.log` (JSON lines with `ts`, `phase`, and `filePath`,
  but no `pid` or `type`). Use the selected time window and `filePath` to
  narrow by project. Label counts as project/time-window evidence, not
  pid-attributed evidence; flag shared-project and non-path rows as
  attribution-ambiguous.
- The previous readout for the same project when one exists (an issue comment
  the brief links, or a file under the scratch directory). Every number is
  reported as a delta against it when available.

Read active files, retained numbered siblings (for example, `cascade.log.1`),
and date-only archives (for example, `cascade.log.2026-03-01`), plus timestamped
archives that overlap the selected window. The analyzer includes numbered and
date-only siblings by default; use `--archived` for timestamped archive names
containing `T` (for example, `cascade.2026-03-01T12-00-00Z.log`, the form session-start cleanup writes). Filter rows by
the selected window in every file. A missing active file does not make its
retained siblings empty; flag incomplete retention when the files do not cover
the requested window.

## The readout (fixed shape, one comment or file, never stdout to the session)

1. **Session line**: pid, project root, first/last row timestamps, row count,
   pi-lens version if a session-start row carries it.
2. **Phase table**: group `latency.log` rows with `type:"phase"` and
   `cascade.log` rows from all selected files by `source | phase`, using the
   log family as `source` across active and archived siblings. Report
   `n | timed_n | p50 | p95 | max | total_ms`, sorted by total, top 15.
   Count every row in `n`; compute
   timing columns only from numeric `durationMs`, in ms, with `timed_n`
   showing that sample count. Show `-` when no durations exist. List count-only
   phases separately so the timing top 15 cannot hide `cascade_carry_rendered`;
   include its `metadata.carriedRunsRendered` and `metadata.labeledAdvisories`
   totals.
3. **Bounds reached at p50** (shape 41): every phase whose p50 is within 10%
   of a declared budget or timeout in its metadata (`budgetMs`, `timeoutMs`,
   `elapsedMs` ≈ budget). Name the constant when it is known
   (`PI_LENS_AUX_GRACE_MS`, `TOUCH_DEBOUNCE_MS`, drift batch) and the awaited
   path it sits on (tool_result, agent_end, background).
4. **Per-server auxiliary outcomes**: from `lsp_aux_wait_outcome.metadata.outcomes[]`,
   one row per `serverId | outcome | publishedThisContent`, with n and p50/p95
   `elapsedMs` versus `budgetMs`.
5. **Degradation and error lines**: counts by `kind` from the degradation
   records and by `message` from `extension.log` at `level:"error"`; any
   message that repeats per file or per occurrence is flagged as catalog
   shape 10 with the emit site if it can be found by grep.
   Also report `Situational dead weight` from the `tools` extension-log row,
   including its bounded `metadata.tools` list; `[]` means every situational
   tool was activated or called in the conversation. A shutdown with
   `targetSessionFile` emits the ending conversation's row before a new set
   opens for new, resume, or fork. Reload re-runs the extension factory but
   keeps the same session file, so it preserves one conversation row. Caveat: resuming into the session you are already in still carries `targetSessionFile`, so one conversation is split into two rows and a tool activated before the resume is listed as dead weight in the second (pi exposes no current-session-file accessor; not fixed). A process restart (`pi --continue`) recovers
   nothing — the restore deactivates every situational tool — so the first row
   after one legitimately lists all five, and shrinks only as the model
   re-activates and uses them. MCP remains connection-scoped and owns the
   terminal latch.
6. **Backlogs**: `lsp_document_drift` rows by disposition, files affected,
   `driftAgeMs` p50/p95/max; `lsp_document_drift_cap` rows (at most one per
   session) with `tracked` and `cap` when the tracked-document set stands above
   `DRIFT_TRACK_CAP` because every record belongs to a document a live server
   still holds (#4503) — `tracked - cap` is the excess at the first crossing,
   not the held-document count or later growth; `agent_end_deferred_mutation_drain` durations and
   coalesced path counts; `deferred_format_file` runs with `changed:true`
   versus total. A formatter that never settles is visible only as an
   anti-join (#3828): a `deferred_format_post_exit_resync` row with
   `outcome:"abandoned"` (beside the `hook-await-exceeded` degradation
   `off_hook:deferred-format-post-exit-resync`) and no
   `deferred_format_late_resync` row on the same `filePath` afterwards. Report
   the count of such files. A late row names what happened to the file
   (#3828 r3): `resynced` is the healthy end of the chain; `unheld`,
   `no-service` and `vanished` had nothing to sync; `deferred` is still queued
   for the next drift pass; `failed` did not land. The in-band
   (`--immediate-format`) caller writes the same rows as `inband_format_late_resync`
   (#3858) with the same outcomes. Both callers write one
   `format_late_resync_chained` row (`metadata.which`: `inband` or `deferred`)
   when the give-up chains the late resync (#3873), so a give-up is countable by
   `filePath` even for a formatter that never settles or an Escape; a chained
   file with no later `*_format_late_resync` row on the same `filePath` is the
   anti-join to report.
   `withheld_blocker_late_advisory` (#5108) is the same hand-off for a
   tool_result handler the host bound abandoned while a run without authorship
   withheld blockers: one row per abandoned call that queued its disclosure
   for the calling session's next context call, with `metadata.notices` (the
   withheld lines; the advisory shows five) and `metadata.budgetMs`, and the
   tool name as `filePath`. The row is written even when the advisory never
   reaches the agent: a full queue or a session that ended before its next
   context call drops it as the `agent-advisory-dropped` degradation (`cap`
   or `scope-retired`), so report the pair.
   **Session decisions** (#3873; each row is one lifecycle event, none is per
   occurrence in a loop): `session_handoff_slot` (`op`: `stashed`, `replaced`,
   `taken`, `key-mismatch-left` (once per stale slot), `forwarded`,
   `unconsumed-at-exit`; `by`,
   `reason`, `keyHash`, `storeNames`, `ageMs`), `session_handoff_adopt` (one
   per primary start: `tried[]` with `source`, `found`, `version`, `ageMs`,
   `storeNames`, and `chosen`), `session_store_action` (one per declared store
   per primary start: `action` `adopt`/`reset`/`skip`, `payloadPresent`,
   `itemsIn`/`itemsKept`/`itemsDropped`), `session_scope_transition` with the
   `end` (a scope superseded without a shutdown) and `demote` (a start in a
   replacement gap that is not the successor the shutdown named: a subagent
   that binds in the gap is one, a real successor an interrupting reload
   displaced is another; a subagent beside a live primary writes none)
   transitions,
   `session_end_fence_rollup` (one per primary shutdown: `sources[]` with
   `guarded` and `dropped`, plus totals), `session_handoff_turn_state` (#4751:
   one per primary that takes the turn-state worklist at its turn_start;
   `arm` `predecessor` (from an in-process predecessor: `from`, its files kept
   as `filesKept`), `evicted` (from a predecessor past the stale bound: `from`,
   its files dropped as `filesDropped`) or `empty`, and `to`),
   `lsp_created_import_scan_rollup`
   (one per primary shutdown when the created-module producer ran: `calls`,
   `importers`, `targets`, `capped`, `oversized`, `totalMs`, `maxMs`). Read `read_guard_branch_retained` with
   `payloadReads`: `kept 0, dropped 0` is a missing payload when `payloadReads`
   is `null`, an empty read set at `0`, and an ignored payload when it is above
   0 beside a `payloadVersion` that is not the current one.
   `session_start_total` carries `basis`, `gapMs` and `lineageMatch`;
   `agent_nudge` carries `fileKeys` (hash8), `originSessionIds`, `scopeId` and
   `queueEpoch`, so one touch delivered in three drains is three epochs;
   a no-client `lsp_touch_file` carries `candidates[]` (`serverId`, `rooted`,
   `clientFound`, `generation`) for the file's primary servers only, 8 at most;
   an auxiliary server is listed only in `clientScope: "all"` touches, the one scope that resolves its root (the with-auxiliary scope reports it in `auxiliary_readiness`).
7. **Timeouts**: `lsp_diagnostics_timeout`, `lsp_nav_request_timeout`,
   `lsp_client_wait_timeout` counts with `serverIds`/`source`.
8. **Delta**: for each of the above, the change since the previous readout,
   one line each, only where the number moved by more than 20% or a new
   kind appeared.
9. **Injected context**: report injected bytes per source per turn
   (`sessionGuidance`, `turnFindings`, `testFindings`, `agentNudge`,
   `turnEndAdvisory`, `other`) at p50/p95, plus the repeated-findings ratio
   (`injectedFindingsRepeated` divided by injected finding observations).
10. **Findings**: at most five, each with the number that proves it, the seam
   (file:line when found), and one of: `already filed #N` (search open issues
   first: `gh issue list --search "<phase or kind>"`), `new`, or
   `expected` (with the rule that makes it expected). A finding without a
   number is not a finding.

## Rules

- Premise first: before naming a constant or a seam, read the code that owns
  it (`clients/lsp/index.ts`, `clients/pipeline.ts`, `clients/runtime-agent-end.ts`,
  `clients/lsp/document-drift.ts`).
- Bounded output: the readout is one comment or one file. Never one line per
  row of the log. Quote at most three raw rows, each cut at 300 characters.
- No repo edits, no Git commands, no restarts, no writes under `~/.pi-lens`.
  Scratch files go under the working tree's `.probe-home/` or the scratch
  directory the brief names.
- File nothing yourself unless the brief grants `gh`; then one comment on the
  issue the brief names, never a new issue: the orchestrator decides what
  becomes a lane.
- The analyzer reads discovered sources independently and does not apply a
  pid-evidence stop rule. It reports per-family file and row counts
  (`filesScanned`, `rowsSeen`, `parseErrors`) but cannot classify each input
  as absent, empty, unreadable, or out-of-window.
  Missing files and unreadable directories can yield no discovered input;
  empty files and out-of-window rows contribute no rows. A discovered file
  read error fails the command instead of producing an empty report. Do not
  infer absent or empty inputs from zero counts alone.
- Apply the evidence policy in the monitor's own readout: if the pid is absent
  from the selected latency/extension rows, report that and stop only
  pid-attributed analysis. Continue the project/time-window cascade readout,
  including carry counters, without claiming pid ownership. Inspect the inputs
  separately and report absent, empty, unreadable, or out-of-window states as
  observed, with a bounded `ls -la` inventory of the resolved active files and
  retained archives. After reporting those limits, stop the whole readout only
  when neither kind of evidence is available.

## Deliverable

`MONITOR.md` at the worktree root with the readout, and when `gh` is granted,
the same text as a comment on the issue the brief names (today: #2809).
