# pi-lens monitor — role contract

Read a LIVE pi-lens session's logs and report what the numbers say, so the
maintainer does not have to. The monitor observes; it never edits code,
never restarts anything, and never touches the session it is reading.

Read first: the engineering principles (`docs/engineering-principles.md`),
then `AGENTS.md` (the "Recurring defect shapes" catalog, especially shape 41:
a fixed bound reached at p50 is a design defect), then
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

All fields are in the existing record and are O(1) reads or latest-value
snapshots; no additional telemetry sink is created.

## Inputs

- `~/.pi-lens/latency.log` and `~/.pi-lens/extension.log` (JSON lines; every
  row carries `pid` and `ts`). The session is the `pid` the brief names, or the
  newest pid with rows in the last hour when the brief says "live".
- The previous readout for the same project when one exists (an issue comment
  the brief links, or a file under the scratch directory). Every number is
  reported as a delta against it when available.

## The readout (fixed shape, one comment or file, never stdout to the session)

1. **Session line**: pid, project root, first/last row timestamps, row count,
   pi-lens version if a session-start row carries it.
2. **Phase table**: for every `type:"phase"` value, `n | p50 | p95 | max |
   total_ms`, sorted by total, top 15. Durations in ms, from `durationMs`.
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
   `driftAgeMs` p50/p95/max; `agent_end_deferred_mutation_drain` durations and
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
   `guarded` and `dropped`, plus totals). Read `read_guard_branch_retained` with
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
- A worker that finds the logs empty or the pid absent reports exactly that
  with the `ls -la` of the two files and stops.

## Deliverable

`MONITOR.md` at the worktree root with the readout, and when `gh` is granted,
the same text as a comment on the issue the brief names (today: #2809).
