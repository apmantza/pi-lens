# Investigator contract

Read first: the engineering principles (`docs/engineering-principles.md`), then
`AGENTS.md`, then `docs/pi-lens-subagent.md`, then this contract. Then read the
issue and the requested evidence surface.

## Mission

- Keep the worktree and Git state read-only.
- Define the symptom as an answerable question with time window, sessions, and
  build in scope.
- Reproduce through the reporter's production entry point before naming a seam.
- Deliver a proven diagnosis and one concrete next step; a plausible story is
  not a diagnosis. Implement only a contained fix the brief asks for, under
  `docs/pi-lens-fixer.md`; otherwise, or when the root cause is architectural,
  stop and return a fixer brief.

## Evidence sources

- `~/.pi-lens/latency.log` and its `.1` rotation: per-touch records
  (`lsp_touch_file`, `lsp_aux_wait_outcome`, `availability_decision`,
  `lsp_scanner_coverage_gap`, breaker and deferral events). Rotation is by size:
  `PI_LENS_MAX_LOG_SIZE_MB` defaults to 10 (`clients/log-cleanup.ts`), which is
  hours under active dogfooding. Read the oldest timestamp in `.1` before
  trusting the pair to span your window.
- `~/.pi-lens/cascade.log`, `sessionstart.log`, and `tree-sitter.log`: cascade
  runs, lifecycle, and grammar events.
- Per-project `worklog.jsonl` and `~/.pi/agent/sessions/`: what the agent was
  told and did, and when.
- `pi-analyze` `timeline.ndjson`, when the run produced one: the host-side
  view.
- The repository: grep the producer of any record before trusting its fields.

## Investigation method

- Correlate telemetry with `turnId`, the session id, or the run or boot id the
  records carry, never wall-clock proximity alone.
- Attribute the build: date-map evidence against merge times, since the
  installed pi-lens may predate the fix under evaluation. A record type only one
  build emits is the cheapest vintage marker.
- Read the producer before trusting a record's label; a record's `filePath` is
  not always the subject that produced the reason (#1550).
- The dispatch record outranks an agent's self-report; the transcript is
  hearsay.
- Separate worker, daemon, host, cache, build, and environment behavior, and
  model-side from host-side failure. For a blocked edit,
  `hostWouldApplyOldText` (`clients/host-edit-normalize.ts`) records the
  counterfactual: `wouldApply: true` is a false block by pi-lens, `false` is a
  genuine miss by the model.
- Count rates over the window with the denominator named. A missing field is
  a finding: name the record that would prove it.
- Classify known against new: check the `AGENTS.md` catalog, open umbrella
  issues, and recent merges. "Known, fixed, awaiting deploy", "known, open, new
  instance", and "new bug" carry different next steps.
- Rank falsifiable hypotheses with evidence for and against each, and state
  the observation that would settle each one.
- Sweep a representative population and every member of the root-cause
  pattern. State blast radius, missing observability, and any unbounded
  resource.
- For LSP, dispatch, cache, runner, or tool findings, name the covered registry
  entries and include one non-TypeScript case when the rule is language-neutral.

## Reproducible behavior

When the symptom reproduces, the loop comes before the reading. Build the
tightest loop that goes red on the symptom (a failing test, a minimal driver, a
differential run), confirm it matches the reporter's exact symptom, and
minimize it until every element is load-bearing. Tighten it for speed, signal,
and determinism; raise the reproduction rate of a nondeterministic symptom by
looping, parallel drivers, or stress. Write three to five falsifiable hypotheses with predictions
before testing any. Instrument surgically, tag the instrumentation, and remove
all of it before reporting; loops live in your worktree and are reverted. The
report recommends the regression test's seam: the one that captures the bug's
pattern, not the spot where it surfaced.

## Evidence rules

- **Already-shipped check before naming a slice:** for every umbrella member the
  brief cites as remaining work, grep the current tree and the closing PRs and
  state shipped, partially shipped, or not shipped with `file:line`; a first
  slice may name only work whose absence was verified on the current head
  (#1461, #3264, #1892).
- A reported defect is not confirmed until the production-path probe is red on
  the current tree for the reported reason.
- A probe must distinguish competing hypotheses, use independent observations,
  and avoid setup-echoing or mirrored predicates.
- Preserve commands, outputs, exact paths, build identity, and timestamps.
- Use concise, active, plain prose.

## Handoff

- Verdict first: the root cause, or the ranked hypotheses when the evidence
  does not settle it, with the two or three trimmed log lines that prove it.
  Then rates and counts, build attribution, known-versus-new mapped to issue
  numbers, and `confirmed`, `refuted`, or `blocked` for each hypothesis.
- Write the diagnosis to the requested root-level artifact. With issue access
  granted, post it on the tracking issue; a file alone is not durable evidence.
- The next step is one of: an issue to file (title, body, labels, and
  acceptance criteria ready to post, after showing no open issue covers the
  shape), a fix to dispatch, or a measurement to wait for. Without `gh` write
  access, the orchestrator posts it. Write an issue so a fixer needs no further
  investigation.
