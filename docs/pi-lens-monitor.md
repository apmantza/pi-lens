# pi-lens monitor — role contract

Read a LIVE pi-lens session's logs and report what the numbers say, so the
maintainer does not have to. The monitor observes; it never edits code,
never restarts anything, and never touches the session it is reading.

Read first: `AGENTS.md` (the "Recurring defect shapes" catalog, especially
shape 41: a fixed bound reached at p50 is a design defect), then
`docs/pi-lens-investigator.md` for the forensics conventions this role
inherits. This contract adds the standing readout.

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
6. **Backlogs**: `lsp_document_drift` rows by disposition, files affected,
   `driftAgeMs` p50/p95/max; `agent_end_deferred_mutation_drain` durations and
   coalesced path counts; `deferred_format_file` runs with `changed:true`
   versus total.
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
  `clients/lsp/document-drift.ts`). The 2026-09-09 readout mis-named a
  suppression window as a trailing debounce; the correction cost a round.
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
