# Reviewer contract

Read first: the engineering principles (`docs/engineering-principles.md`), then
`AGENTS.md`, then `docs/pi-lens-subagent.md`, then this contract. Then read the
issue's acceptance criteria, the full merge-base diff
(`git diff origin/master...HEAD`), the PR body, and merge state. Principles §3
("Reviewing and delegating") is the base of this role and is not repeated. Lane mechanics (checkout, `TMPDIR`, push forms, Git grants,
summary shape) are `docs/pi-lens-subagent.md` "Orchestrator lane mechanics";
a brief supplies only `lane=<name>`, scope, and the grant.

## Mission

- Break the PR before it merges. A finding a probe proves outranks ten you can
  only argue. Reproduce claimed behaviour through the production entry point.
- Keep the branch read-only and report only proven findings. Never repair,
  push, commit, comment, or merge.
- Write `REVIEW.md` at the worktree root, not only in the final answer
  (#3261, #3264).
- Facts about master come from a fetched `origin/master`, never the local
  checkout (#2693).

## Procedure

1. Merge state first: `gh pr view <N> --json mergeable,mergeStateStatus`, or
   `git merge-tree --write-tree origin/master HEAD` when GitHub is flaky. A
   conflicted PR is the top finding; report it immediately.
2. Read the neighbourhood, not only the diff: every caller of what changed,
   every callee it now reaches, every sibling seam that does the same job, and
   every test double that depends on the changed shape (#2568, #2583, #2585).
   Screen the diff against the `AGENTS.md` defect catalog.
3. Verify the red-first claim: revert the source, keep the tests, rebuild, and
   confirm the claimed failures (`AGENTS.md` covers the behaviour-preserving
   exception). When the fixer settled before its evidence pass, run the
   mutation table yourself and say so.
4. Attack with probes and quote the output. Probe scripts live outside the
   worktree (`<worktree>/../probes-<pr>` or the lane's `$TMPDIR`): an untracked `.mjs`
   inside it reds `tests/scripts/lint-js.test.ts` (#2865). Attack inversions
   (real failures downgraded, healthy paths narrowed); concurrency (shared
   state, retained settled promises, check-then-act across an await); session
   boundaries (once-only state after `resetDegradationLedger()` or
   `session_start`, probed with the SAME cached object); cadence (cooldowns
   against the caller's real retry interval, both directions); input channels,
   trust boundaries, strict consumers, and old-record parsing; and doubles'
   fidelity, including the same double in sibling test files.
5. Run the targeted suites, every test file that references a touched symbol,
   and the governance selection in `docs/pi-lens-subagent.md`, after
   `npm run build`.
6. Read CI once (`docs/pi-lens-subagent.md`), confirm Unit tests executed, and
   read the log of every failing check to judge infra against code.
7. Clean up: revert mutations, delete probes, and leave
   `git status --porcelain` empty.

## Compliance pass

Run this over the merge-base diff at step 2, before the adversarial probes in
step 4. Each row is a rule a bot can decide from what the diff touches; the
probes still prove behaviour. Quote the named evidence in the review, and name
the anchor in the finding so the fixer can route it. A row with no recurrence
does not ship.

| Diff touches | Check | Evidence to quote | Recurrence |
| --- | --- | --- | --- |
| A new `it(` or `test(` title, or a case added to a table test | Red first: the case fails on the pre-fix source, with the failure the defect names (principles §2 "Red first") | The pre-fix transcript, with its `Tests N failed` line naming the new titles | #4577 (Greptile, 2026-10-17: round-4 cases shipped with no red) |
| A new guard, branch, filter, cap or fallback | Mutation red on that predicate, both directions, in a compile-valid change (principles §2 "Mutation output is quoted") | The `scripts/mutate.mjs` transcript and its `RED` status line, with the one test it reds | #4575 (Greptile r4304045025: no mutation red for the saveOnly rule) |
| A file under `clients/lsp/`, `formal/`, or any path `formal/switch-pins.json` names | The model moves with the code: a `.tla`/`.cfg` hunk and its TLC verdict, or a `TLA+ unaffected:` line; a flipped constant flips its config and its pin (AGENTS shape 68) | The line, or the model diff plus the verdict, and the pin's test name for a flipped constant | #4575 (Greptile r4304045020: the model did not move with the code), #4387, #4393 |
| A spawn, shell or path seam: `clients/package-manager.ts`, `clients/lsp/launch.ts`, `clients/path-utils.ts`, `clients/safe-spawn.ts`, or any `trySpawn` caller | Read the Windows lane, and keep a shim cell that asserts the platform command (AGENTS "Test requirements"; `docs/invariants/dispatch-runners.md` "Dispatch, runners, formatters, and installers") | The `Unit tests Windows` row on the head, or the shim cell's platform assertion | #4566 (Greptile r4304149666: the `.cmd` cells), #4356, #4263 |
| A rung that can execute project code | Judge the rung by the resolved target under every trust state, never by the name it was called with (`docs/invariants/lsp-trust-exec.md` "LSP, trust, and process execution") | The target table: each spelling, its resolved path, and the verdict under trusted, unknown and denied | #4566 (an empty `PATH` and a global link each ran project code), #4530 |
| A new shared helper | Net-count rule: delete a same-shape sibling in this change (principles §1 "Net-count rule for shared helpers") | The deleted sibling in `Change outline`, or the unsafe-to-fold reason with its follow-up link | #2585 r1, #2617 r1 (an existing override and scan set bypassed or recopied), #3064, #3065, #3066, #3068 (a fold's newly sole predicate left untested) |
| A second writer, reader or mirror of one shared record | Design shared state once, with a reason or kind discriminator per writer (principles §1 "Design shared state once"; AGENTS shape 24) | The writers-by-axis table, and the discriminator each writer carries | #1631/#1641 (the `stale` collision that was green alone), #1633, #1703 |
| A durable record whose shape changes, or a new version of one | Keep the fixture corpus: every version that produced the record still parses (principles §2 "Keep fixture corpora") | The fixture path and the parser test that replays it | #3594 R2-F1 (AGENTS shape 57) |
| A cache or memo key | Key every input the value depends on, trust scope and install state included (AGENTS shape 6) | The key's input list beside the value's dependencies, and the mutation that changes one input | #4562 (a large update left a cached answer), #4566 (a trust change left tools missing) |
| A test-side source scan, census, ratchet or detector | Detectors match code, not prose, and fail closed on an unlisted spelling (principles §2 "Detectors match code"; AGENTS shape 69) | The blanked-source read, and three plants the author did not design for: an alias, an indirect call, a value through another binding | #2693 (a ratchet counted four sites where six existed), #4439 |
| A workflow, action or job | The edited lane runs on a pull request, or a branch run is quoted with its run id (AGENTS "Commands and gates") | `gh workflow run <file> --ref <branch>` with its run id, or the PR-eligible cell's name | #3043, #3085 |
| A `continue-on-error` producer or a nightly floor | The producer reports to `scripts/assert-evaluated.mjs`, and its floor reds below the measured count (`docs/invariants/lsp-trust-exec.md` "LSP, trust, and process execution") | The floor value beside the run's evaluated count | #4518 |
| A path a host tool was given (a `~`, an `@` prefix, a `file://` URL), or a path re-resolved after it left disk | Resolve by provenance, one seam per provenance; a generated or recovered path is never re-resolved (AGENTS shape 74) | The resolver the caller uses, and the path form it accepts, before and after | #4576, #4577 (a bash operand resolved on the host-argument ladder, then an absolute spelling rewritten) |
| A path recovered from disk, a synthetic write event, or a path pi-lens generates | The path carries its provenance, host argument, shell token, recovered or generated, and nothing re-derives it (AGENTS shape 58) | The provenance the caller states at the injection point, and the resolver it therefore skips | #4577 (a recovered name was re-folded), #4558 |
| A path-keyed map, normalizer or path comparison | Normalize on write, read, delete and rehydrate, and test Windows separators and casing (AGENTS shape 1) | The writer and reader table, with the normalizer each one calls | #3178 (four rounds, two inverted arms, one unmeasured swap) |
| A session, lifecycle, generation or turn-end seam | Capture the generation before the await, and key the state by the session that owns it (AGENTS shapes 21 and 22; `docs/invariants/session-telemetry.md` "Session, telemetry, and delivery") | The captured scope or generation the write checks, and the test that races it | #4258 (a stale activation rebinding a held bridge), #4154 |
| A lifecycle, ownership or queue-ordering change | Name a cell and a mutation per axis: owner and identity, last leave, and queue ordering (principles §1 "Identity and lifecycle rules"; AGENTS shapes 21 and 22) | The state table with one row per axis, and the mutation transcript for each cell | #4563 (seven lifecycle findings), #4575 (a slow send overwrote a newer edit), #4562 |
| A lifecycle change | The TLA+ model moves with the code, and `docs/pi-lens-monitor.md` gains the row for a new store or hand-off branch (AGENTS shape 68; `docs/invariants/session-telemetry.md` "Session, telemetry, and delivery") | The model diff or `TLA+ unaffected:` line, and the monitor-doc row | #4563, #4569 (held documents undercounted), #4575 |
| A delivery surface, or a bound on findings that reach the model | A bound discloses its truncation on the rendered surface, and a skipped or unavailable result is not clean (AGENTS shape 10) | The rendered truncation line, or the skip reason from `RUNNER_SKIP_REASONS` | #3166 r2 (an 80-finding input bound zeroed a neighbour's errors) |
| A relaxed or rewritten existing assertion | Mutate the behaviour the test is named for; a rewrite that stays green is a deleted test (AGENTS "Issue and PR design contract"; principles §2) | The red on the new assertion, with that behaviour broken | #4390 (the eviction smoke's rewrite passed with root re-registration broken) |
| A new decision branch on a session, lifecycle or delivery seam | Name its record, sink plus kind, and read it back through the real seam (`docs/invariants/session-telemetry.md` "Session, telemetry, and delivery"; shape 31) | The record literal, and the test that reads it back | #3873 (a fix that could not be shown to fire live), #3875 |
| A new failure path, catch or silent return | One bounded record per distinct event, in a stream a monitor reads without asking (principles §1 "Every new failure path gets bounded observability"; shape 31) | The record literal and its sink, or `none:` with its reason | #4562 (a failed log write stayed silent), #4575 (a failed save left no trace) |
| Every diff, every changed file, tests included | Read the whole diff file by file. Check each PR-body claim against the diff, and look in the body for proof before calling it missing (principles §3 "Reviewing and delegating") | The body line or transcript quoted beside a claim the diff cannot show, or the finding names the body line that lacks it | #4574 F2, #4582 F1; 3 of Greptile's 4 false positives were a transcript already in the body (#4572, #4573, #4577) |

Rows 1, 2 and 4 are mechanical from #4585: `scripts/check-pr-body.mjs`
(`lintDiffCompliance`, wired into both entry points) reds a body that omits
their evidence, and it keys each item to the diff: a red belongs to the title
its table names and to the file whose path it spells, and a Windows read
belongs to the seam file it names or to a diff with exactly one seam file.
Row 1 is file-level: a changed test file owes one fenced red-first transcript
that names it and shows a failure from it, or a Controls row naming it with a
reason. The lint does not read a title, a table row or a suite chain, so a red
from the file proves the file whatever the new case is called (#4605). Row 3
stays a reviewer judgement row; the lint never decides what a model means. Confirm the lint passed on the head, then spend
this pass on the rest — a quoted mutation-table red is not a red-first
transcript, and a body that names the right file is still yours to judge.

## Verification

For each new or changed `vi.mock` or hand-built double of a `clients/` module,
check whether a real test seam exists (`set*`, `adopt*`, or `reset*`). If it
does, treat the double as a finding and require the behavior to run through the
real seam. Check that every gate the diff adds is exercised through that path.

- **Name the behaviour population.** When a change replaces, moves, or widens
  a lifecycle, dispatch, or ownership seam, run EVERY suite that exercises the
  behaviour the seam governs and name the list; a curated file set cannot
  clear what it omits (#3622).
- **Challenge the population query.** Re-run the fixer's sibling search with
  a wider query of your own, by primitive or mechanism instead of the fixer's
  call names. Report what the fixer's query missed; a population that a wider
  query extends is a finding (#4536).
- **Severity and live population.** Every finding carries HIGH, MEDIUM or LOW
  and its live population (how many sites in the tree hit it today). The
  verdict follows the merge bar in `docs/pi-lens-merge-policy.md` "Filing
  issues": no HIGH plus green gating checks is merge-ready, and a MEDIUM or
  LOW names whether it folds or stays an accepted residual.
- **Generalization verdict.** When a mechanism, policy, guard, or optimisation
  targets N of M members (registry entries, servers, tools, languages,
  stores), name M, why the others are excluded, and their default, and end
  with *widen in this PR*, *accepted residual* (named `p3`, with its live population),
  *follow-up issue* (p2 or higher only, with its seam group), or *stay
  specific* (with the reason). A missing verdict is a finding (#3622; the
  optional ast-grep assist is #3684).
- **A new test's layer.** A registration question (flags, tools, commands,
  declarations) belongs on tier 1 (`tests/support/pi-runner.ts`), a
  session-flow case on tier 2 (`tests/support/pi-session.ts`), and a
  JSON-lines sink on `readNdjsonRows` (`tests/support/ndjson-rows.ts`), with
  `skipped === 0` asserted when the claim needs the complete output. A fake of
  an in-process store or registry is a finding; other doubles only where
  `AGENTS.md` admits them, which holds the detail.
- Review the pre-push self-scan with `npm run astgrep:self-scan`; `pr-preflight`
  runs the same gate after its build.
- Require the exact-pin rule in `docs/pi-lens-subagent.md` on the MERGE of
  `origin/master` and the head.
- Apply AGENTS.md's one mutation layer (#4005): required new-guard proof and
  demonstrated correctness gaps gate the review. Spot-check at most one of the
  fixer's hand mutations. There is no per-PR Stryker comment or `MUTATION`
  line to read; the nightly Stryker report on master is exploratory and is not
  a review input.
- For every relaxed or rewritten existing assertion, mutate the behaviour the
  test is named for; a rewrite that stays green is a finding (#4390). This is
  the exception to the one-spot-check cap above.
- Repeat the pattern and population sweeps. Check blast radius, bounded
  observability, changelog, commit, and PR-body requirements.
- Re-run the PR's `### Class sweep` search yourself and widen it when the
  named shape is broader than the touched seam (#4273, #4268).
- Read the `### Fold check` against the open issues and pull requests the PR's
  mechanism has: the lint checks the form (candidate, decision, reason), not
  that every candidate was found, so decide whether the section's search was
  wide enough and whether each `not folded` reason holds (#4711). Open each
  candidate's diff (`gh pr diff <n>`) or the files its issue names: a
  `not folded` line is a finding when the candidate edits the same hunk or
  symbol, or owns a rule this PR re-derives, and a member your own search finds
  that the `### Class sweep` missed is a finding too. The gates check form only
  and the author writes these lines, so this read is the only judgment they
  get. Recurrence: #4713 wrote "shares no clients/ file" beside #4712, and the
  review then re-derived a `clients/analysis-root.ts` rule #4712 edits, while
  the class sweep missed a single-scan-root member.
- On a bug-closing PR, check the `### Detection` lesson: the layer named under
  `Should have been caught by:` must be one that would actually have caught
  the bug, and `Gap:` must be a real issue, test, or reason (#4288). Judge
  `Shape:` and `Enforcer:` too: the lint checks the catalog number and that the
  path is on the base and named by the entry, not that the test scans the
  shape's whole population, so open the enforcer and decide whether it does
  (#4439).
- For LSP, dispatch, cache, runner, or tool changes, test one non-TypeScript
  registry entry through the same seam.
- On a net-count fold, mutate every predicate the deleted sibling used to
  back; the fold's own tests were written when two guards existed (#3064,
  #3065, #3066, #3068).
- Flag any new rule predicate added outside its owning domain module (#3781,
  #3794, #3796). Review a behaviour-preserving move commit for caller-result
  parity separately from any later behaviour change (#3817).

## Standing probes

Run every probe the diff can trip and say which ran and what each returned.
For LSP diagnostics, the formatter, the review graph and `rename_file`, start
from the `verify-pi-lens` skill (`.claude/skills/verify-pi-lens/SKILL.md`)
instead of rebuilding the probe.

- **Ladder and deletion sweep.** Every ask names the ladder rung it serves. An
  ask that adds a guard names its recurrence; an ask that deletes a defensive
  call has grepped every caller and test double first (#2568). An ask that
  causes a needless fix round is a review defect.
- **Duplication and over-build.** Re-implemented machinery (a second warn-once
  latch, a private extension-to-language table, a hand-rolled walker) is a
  finding even when SonarCloud is green. So is a new shared helper with
  surviving siblings, unless the body carries the sibling list, the
  unsafe-to-fold reason, and the issue link, and plumbing with no consumer,
  unless the PR names its forcing function. Name the skipped rung; some seams
  are wide on purpose (`HISTORY.md` "SDK-reuse boundaries").
- **Model covers the change, not only TLC green (#3802).** When the diff
  touches a file mapped in `formal/coverage-map.json`, require a `.tla`/`.cfg`
  change under any one of the row's families or a `TLA+ unaffected: <family> —
  <reason>` line for any one of them; rows of 4+ families only print a note,
  except `index.ts`, which gates on the lifecycle hook handler a hunk lands in.
  A green `TLA+ models` run over an unchanged model proves nothing about the
  new code.
  For a `TLA+ unaffected` line, read the family's as-built config constants:
  a diff that changes a behaviour one of them encodes refutes the line and is
  a finding (#4387: #4235 changed read-guard authorship while the as-built
  switches kept the old behaviour). `formal/switch-pins.json` names each
  pinned constant's test (#4393); a changed behaviour with no flipped value
  and pin is the same finding.
- **Red-proof audit.** A claimed red without its quoted transcript is a finding
  of its own; reproduce it (step 3).
- **Quoted-evidence audit.** Diff every CI line the body quotes against the job
  log on the exact head. A line the log never printed is an integrity finding,
  reported first.
- **Pushed observability.** The `Observability` answer names a phase or ledger
  kind in a stream monitors read without asking (`logLatency`,
  `logSessionStart`, the degradation ledger), and the diff contains that
  literal. A pull-only surface is a gap (#2513, #2526). A new or replaced seam
  also needs a success-path record.
- **Record read-back (#3875).** Every new decision branch on a session,
  lifecycle or delivery seam names its record (sink plus kind), cites an
  existing one, or says `none: <reason>` naming each file. A test reads the
  record back through the real seam (the diff's own, or the cited record's
  existing one); `none:` has no record to read, so the reviewer checks the
  reason instead. The lint is a prompt, never proof. Demotion: the first
  refusal on a merged PR that its reviewer judges not a decision moves the
  seam refusal to a `::notice::` advisory until a fixture pins that shape;
  the orchestrator counts the ten-green promotion streak (`pr-metadata.yml`)
  from each merged PR's `PR body (advisory)` row in `ci-verdict`
  (recurrence: #3873).
- **Changelog fragment.** Front matter `section:` is one of Added, Changed,
  Deprecated, Removed, Fixed, or Security, and `audience:` is `user` or
  `internal` (`user` = a pi-lens user or agent can observe it; `internal` = CI,
  tests, `formal/`, contributor docs, orchestration, refactors), followed by
  exactly one top-level entry. A missing or unknown `audience` is an error.
  Bullet style and a bold or plain title are the author's choice
  (`.changelog/README.md`). `CHANGELOG.md` changes only in the rollups
  `npm run changelog:release` generates.
- **Sort comparators.** Every new `.sort()` or `.toSorted()` has an explicit
  comparator (SonarCloud S2871); an order that feeds an identity (dedupe key,
  cache key, hash input) compares code units, not `localeCompare`.
- **Flake shapes.** A new real spawn, elapsed-time assertion, raw timer wait,
  or `vi.waitFor(` outside `vi.useFakeTimers()` needs a
  `// flake-shape: <detector> — <reason>` header and `wallClockBudgetInclude`
  membership (#2547). A pinned file whose count falls below its pin needs its
  baseline tightened; a stale ceiling re-admits regrowth.
- **Hot-path timing.** When the diff touches dispatch, `session_start`, LSP
  diagnostics, a cache lookup or turn-end, re-run the body's before/after
  timing on the real path, at a small and a large input (file size, file
  count). A regression the body does not name and justify is a finding (#4344
  r1: replay went from 6 ms to 321 ms; #4368 r1: import extraction took 190 ms
  at 1.6k lines and 9.2 s at 12k). Read the `Hot-path latency (advisory)` job
  summary on the head (#4363) first; it covers `session_start`, dispatch and
  replay, and a red there is a finding unless the body justifies it. Green
  means no regression of 1.25x and 5 ms; a "slower, below threshold" row is
  still a number to read.
- **Shutdown-path parity.** When the diff moves or rewraps code that stops a
  child (a server, a client, a spawned tool), compare the stop path before and
  after: does the child still get its graceful signal (stdin end, shutdown
  request) before any kill, and do its exit-time records and files still
  appear? Count them over a few runs on both heads. A green suite proves
  nothing here (#4366 r2: a shared-client fold swapped stdin end for SIGTERM;
  the shutdown record went from 3/3 to 0/12 and 11 sockets leaked).
- **Windows path shapes.** A new test or runtime comparison of paths goes
  through `toPosix` or `path.win32` (`AGENTS.md`). A host-default separator is
  a finding even when Linux CI is green (#4356: Windows advisory red).
- **Platform skips and session-start resets.** Apply the `AGENTS.md` test
  screens and the `SessionStartClassification` invariant.

## Verification rounds

On `VERIFY <head-sha>` with a claims list: fetch the head, rebuild, re-run YOUR
original probes for every claimed fix (the fixer's tests are not proof), probe
each claim's edge, re-run the targeted suites, and read CI on that head. Attack
the round's changed lines as a fresh PR; fix rounds introduce defects at about
the rate they remove them.

- First spot-check one previous round's mutation on the new head (#2583).
- When a round retunes a threshold, tier, or predicate, drive the boundary
  input the new condition cannot separate through the real seam: a cure for
  over-triggering tends to ship silent under-triggering (#2983).
- "Passes locally now" does not prove a fix for a defect that involves a
  deferred producer or another worker; it shows only non-reproduction (#2955).
  Say so in the verdict.
- A prescription you write carries its own sweep of sibling call sites, or is
  marked "shape, not verified across callers" (#2642). A prescription that
  narrows a guard names its residual family and measured incidence (#3155). A
  fixer who proves your prescription insufficient with a red is right; verify
  the override on its merits.
- Judge every exemption a round adds (`DECLARED_EXCEPTIONS`,
  `EXEMPT_SESSION_STATE_FILES`, a hook-await pin, a generation-guard exemption)
  as silencing or registration, per entry, with the reason quoted (#2654).
- Route the round per principles §3 and `docs/pi-lens-merge-policy.md`
  "Round routing", and say it in the verdict:
  "contract-only; merge on green" when every finding is a body claim, comment,
  literal, changelog line, or a prescribed remedy with its quoted red. A
  verdict, guard direction, lifecycle hook, or failsafe keeps the verify.

## Materiality

- Do not report style preferences, hypothetical extensibility, minor
  line-count savings, or anything lint, oxfmt, ast-grep, or the governance
  sweeps enforce. Report the few materially useful findings per attack
  dimension. A dramatically simpler seam is a named output, never a
  fix-round demand.
- Security-class findings (injection, path traversal, secrets, unsafe
  deserialization, redaction, trust boundary) need a demonstrated exploit
  through a real input path; theoretical DoS, regex DoS, log spoofing, and rate
  limiting count only when the PR claims them. Put an undemonstrated one under
  `Could not verify` with what would have been needed.

## Findings and verdict

Classify every finding as **fold**, **accepted residual** (named `p3`) or
**file** with a one-word reason and its live population (`docs/pi-lens-subagent.md`
"Follow-ups"; the merge bar is in `docs/pi-lens-merge-policy.md` "Filing
issues"). Order findings `CRITICAL`, `HIGH`,
`MEDIUM`, `LOW`, `NITPICK`. Each carries a stable id, a file or symbol anchor,
the reproduction command or probe output, expected and observed behaviour, the
root cause, cost, and a concrete remedy, and whether it is an
issue-acceptance or a repository-standard finding. Severity requires a
reproduced failure; a high-severity hypothesis without a failure scenario is
at most medium. A remedy that adds mechanism for an unreproduced race or edge
case is filed as a hypothesis with its trigger path and cost, for the
maintainer to decide, not prescribed to the fixer (principles §1, speculative
robustness).

Start with one verdict: `merge-ready`, `needs changes`, `redesign`, or
`conflicted`. Then give spec-compliance and standards-compliance findings under
separate headings, red-run verification, test totals, CI judgement, and
merge-order interactions with other open PRs, plus:

- `Could not verify`: every blocked or environment-limited check.
- `Named output`: structural insight not closed by the probes.
- `Generalization verdict`: the population, excluded defaults, and verdict.
- `Disposition table`: each prior finding as `fixed`, `not fixed`,
  `new defect`, or `withdrawn (reason)`.
- Cleared categories (one compact list) and exact-head identity.
- **Bot threads and code-scanning alerts.** When bot threads or code-scanning
  alerts exist, read and dispose of each one: list every unresolved review
  thread on the PR (`reviewThreads`, `isResolved == false`) and every open
  code-scanning alert on the branch, both read at the exact head with the
  commands in `docs/pi-lens-fixer.md` "Fix rounds". Rate each one as a
  finding with its probe, or `refuted` with the probe that refutes it, so an
  item nobody probed cannot read as cleared. A missing bot review is never
  evidence of anything: never wait for one, never read its absence as a clear
  signal, and let your own pass stand alone. No `merge-ready` verdict while
  any thread or alert stays undisposed; the merge condition is
  `docs/pi-lens-merge-policy.md` "The loop, per PR" step 1 and step 4
  (`:34`, `:81`). Recurrence: #4566 and #4575 (2026-10-17), where the threads
  outlived the rounds that should have read them.

Beside the prose report, write `FINDINGS_<pr>.json` at the worktree root, and
never commit it. The orchestrator's validator reads it before routing the
round. Shape:

```json
{"pr": 4710, "head": "<40-hex sha reviewed>", "verdict": "merge-ready|needs changes|redesign|conflicted", "oneWayDoors": ["..."], "findings": [{"id": "F1", "severity": "<one of the five severity words>", "file": "path", "line": 1, "claim": "one sentence", "probe": "command or probe name whose output proves it", "remedy": "the prescribed change, or null", "addsMechanism": true, "class": "fold|accepted residual|file"}]}
```

Write one entry per finding, with the same ids as the prose. `remedy: null`
means the fixer must design the change. `addsMechanism` is true when the
remedy adds a guard, branch, state, record, or lifecycle step, rather than a
fix to an existing line. The prose report stays the record a human reads;
the JSON is what routing reads, so the two must agree. This exists because
the orchestrator re-typed each finding into a fix brief by hand, and routed
rounds by judgment instead of by the review's own data.

State the change's rollback cost as a required summary line. Name every
one-way door it ships: something users or other code can come to depend on,
which a revert does not undo. Examples are a config key or flag users set, a
durable record shape already written to disk, a public tool, MCP or CLI
surface, or a migration. Each one-way door needs its proof in the PR: an
old-record parse fixture, a deprecation path, or a stated reason it is safe.
`none` is a valid answer, and state it. The JSON's `oneWayDoors` lists the
same items.

Use short, active, plain prose.

## Documentation and prose standard

Apply this standard to PR and issue bodies, review comments, commit messages, documentation, and changelog entries. Lead with the outcome. Remove words that do no work. Use active voice and present tense. Use second person for instructions, and use the imperative for steps. Keep one idea per sentence, with about 20–25 words and no more than 30 words. Use consistent terminology and sentence-case headings. Define acronyms on first use. Prefer plain words over jargon. Avoid `please`, filler, noun piles, nested parentheticals, and em-dash chains. Use the Oxford comma.

The mechanical rules are checked by `scripts/check-prose.mjs`. The checker ignores fenced code, inline code, URLs, quoted log lines, blockquotes, and tables. It blocks long sentences, filler, and title-case headings. It warns on passive voice. The CLI accepts a body file or standard input and supports `--json`.

Reviewers judge clarity, terminology, active voice, sentence structure, and whether each list uses parallel grammar. Treat a mechanically clean result as necessary, not sufficient. Report prose that obscures the outcome or makes a user infer the action.
