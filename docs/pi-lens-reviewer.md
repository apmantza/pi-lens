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

## Verification

For each new or changed `vi.mock` or hand-built double of a `clients/` module,
check whether a real test seam exists (`set*`, `adopt*`, or `reset*`). If it
does, treat the double as a finding and require the behavior to run through the
real seam. Check that every gate the diff adds is exercised through that path.

- **Name the behaviour population.** When a change replaces, moves, or widens
  a lifecycle, dispatch, or ownership seam, run EVERY suite that exercises the
  behaviour the seam governs and name the list; a curated file set cannot
  clear what it omits (#3622).
- **Generalization verdict.** When a mechanism, policy, guard, or optimisation
  targets N of M members (registry entries, servers, tools, languages,
  stores), name M, why the others are excluded, and their default, and end
  with *widen in this PR*, *follow-up issue* (with its seam group), or *stay
  specific* (with the reason). A missing verdict is a finding (#3622; the
  optional ast-grep assist is #3684).
- Review the pre-push self-scan with `npm run astgrep:self-scan`; `pr-preflight`
  runs the same gate after its build.
- Require the exact-pin rule in `docs/pi-lens-subagent.md` on the MERGE of
  `origin/master` and the head.
- Apply AGENTS.md's one mutation layer (#4005): required new-guard proof and
  demonstrated correctness gaps gate the review. Spot-check at most one of the
  fixer's hand mutations. There is no per-PR Stryker comment or `MUTATION`
  line to read; the nightly Stryker report on master is exploratory and is not
  a review input.
- Repeat the pattern and population sweeps. Check blast radius, bounded
  observability, changelog, commit, and PR-body requirements.
- Re-run the PR's `## Class sweep` search yourself and widen it when the
  named shape is broader than the touched seam (#4273, #4268).
- On a bug-closing PR, check the `## Detection` lesson: the layer named under
  `Should have been caught by:` must be one that would actually have caught
  the bug, and `Gap:` must be a real issue, test, or reason (#4288).
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

Classify every finding as **fold** or **file** with a one-word reason
(`docs/pi-lens-subagent.md` "Follow-ups"). Order findings `CRITICAL`, `HIGH`,
`MEDIUM`, `LOW`, `NITPICK`. Each carries a stable id, a file or symbol anchor,
the reproduction command or probe output, expected and observed behaviour, the
root cause, cost, and a concrete remedy, and whether it is an
issue-acceptance or a repository-standard finding. Severity requires a
reproduced failure; a high-severity hypothesis without a failure scenario is
at most medium.

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

Use short, active, plain prose.

## Documentation and prose standard

Apply this standard to PR and issue bodies, review comments, commit messages, documentation, and changelog entries. Lead with the outcome. Remove words that do no work. Use active voice and present tense. Use second person for instructions, and use the imperative for steps. Keep one idea per sentence, with about 20–25 words and no more than 30 words. Use consistent terminology and sentence-case headings. Define acronyms on first use. Prefer plain words over jargon. Avoid `please`, filler, noun piles, nested parentheticals, and em-dash chains. Use the Oxford comma.

The mechanical rules are checked by `scripts/check-prose.mjs`. The checker ignores fenced code, inline code, URLs, quoted log lines, blockquotes, and tables. It blocks long sentences, filler, and title-case headings. It warns on passive voice. The CLI accepts a body file or standard input and supports `--json`.

Reviewers judge clarity, terminology, active voice, sentence structure, and whether each list uses parallel grammar. Treat a mechanically clean result as necessary, not sufficient. Report prose that obscures the outcome or makes a user infer the action.
