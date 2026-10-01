# Fixer contract

Read first: the engineering principles (`docs/engineering-principles.md`), then
`AGENTS.md`, then `docs/pi-lens-subagent.md`, then this contract. Then read the
issue with its comments (`gh issue view <N> --comments`): its acceptance
criteria are the contract. Rules the principles or `AGENTS.md` already state
are not repeated here.

## Before code

- Trace the production entry point and reproduce the defect through it
  (principles §1, "Premise first"). Name no seam before the reproduction; the
  red reproduction is your feedback loop, built before any theory of the fix.
- Climb the minimalism ladder before screening against the `AGENTS.md`
  catalog: the catalog says what must not break, never what to add.
- Check which open PRs touch your files (`gh pr list`, `gh pr diff`), design to
  compose, and flag merge order in the PR body. Branch `fix/<N>-<slug>` from
  `origin/master` unless the brief names a branch. Preserve contributor
  authorship on a contributor's branch.
- Write the failure list in the PR body before the first edit (principles §2):
  inputs, states, orderings, and platforms; a space with two axes is a table.
  The tests cover that list, not only the happy path. For a change to N of M
  members, the list also names M, the excluded default, and the planned
  generalization verdict: *widen in this PR*, *follow-up issue* with its seam
  group, or *stay specific* with the reason (#3622).
- When a gate becomes fail-closed, sweep every construction site that reaches
  it, test doubles included, and prove the sweep with the behaviour suites
  (#3622).
- A change on a lifecycle, timing, or identity seam extends or adds a TLA+
  model in this step (#3802; the rule itself is in `AGENTS.md`). Find the
  family in `formal/coverage-map.json`, write the invariant the change
  preserves or tightens, and show the violating config red on the pre-fix model
  and green after, or carry `TLA+ unaffected: <family> — <reason>` in the PR
  body. A row is any-of (one listed family's model move or declaration
  satisfies it); a row of 4+ families only prints a note until hunk-level
  matching exists (#3878). The map owner is the lane that adds a
  `formal/<family>/`: it adds the family and its map row in the same PR, and
  `validateCoverageMap` reds the Unit tests lane otherwise.
- Seams are named in the brief before the round. A fixer that needs an
  unconfirmed seam stops and reports it as a finding, not as a test.

## Scope

- A fix round does not deepen: no refactor, helper extraction, or rename
  beyond the fix's own lines; deepening is its own slice under the owning
  umbrella (#3178). Every hunk serves a finding or an acceptance box. Orphans
  your change created come out; dead code you only noticed goes to the
  follow-up section.
- A behaviour-preserving move is its own commit: callers keep exact results and
  tests stay green; put any behaviour change in a separate commit (#3817).
- Delete vacuous tests in the files you touch (a case that reds on no
  mutation, asserts a constant, or duplicates a sibling), with the sweep
  transcript quoted in `Test assessment`. A redundant test that still guards
  goes only with the named survivor that covers it.
- Apply folded review follow-ups per `docs/pi-lens-subagent.md`
  "Follow-ups", and list filed residuals in one **Residuals** section of the
  PR body.

## Evidence

- Witness rule (ADR 0007): #1605 owns the witness lanes, and their fixtures
  live under `tests/fixtures/witness/<slice>/`.
- Red-first has one stated exception: when the only red-first path needs broad
  harness setup, brittle mocks, or a test you would delete right after it
  proves the fix (shape 7: #1114, #1759), state the exception in `Tests`, name
  the closest executable check you used, and expect the reviewer to dispute it.
  A silent omission is a defect.
- With Git authority, commit the code once the targeted suite is green and
  after every proven step, before any checkout-based proof; add evidence in a
  later commit (#3268). Produce a red by restoring only the mutated source path
  from the pre-fix SHA (`git checkout <sha> -- clients/…`), never `tests`
  (#3166) and never uncommitted work, and run `git status` after any bulk
  restore. Without Git authority, use a saved patch.
- Hand-mutate only the NEW guard, branch, filter, or cap the PR is about, both
  directions, one row per direction, and quote the compile-valid red. The new
  test is the only red under at least one mutation. Stryker samples at most 6
  files and cannot give the red-first proof, so it does not replace this.
- After the push, read the `Mutation diff` comment for your exact head (its
  `Head:` line must match; `node scripts/ci-verdict.mjs <pr>` prints a
  `MUTATION` line). Kill every survivor on a line you added with a test in the
  PR, or show it equivalent with a reason in the PR body. Name a 0-mutant,
  partial, or absent comment in the body, never read it as clean, and run
  `node scripts/stryker-diff.mjs --base origin/master --max-files 6`, then
  `node scripts/mutation-report.mjs` on `reports/mutation/mutation.json`.
  The `mutation` job starts only after every required check passed on the head
  (#3801): until then the `MUTATION` line reads `PENDING`, and after a red
  required check or a red gate it reads `NOT RUN` with the reason.
- Every record the `Observability` section names is asserted by a test in the
  diff and quoted in the body (#2642, #2647, #2649, #2654).
- Every behavioural sentence (a docstring invariant, a memo, a registry
  justification) maps to a test or a probe, or is deleted (#2643, #2654).
- Name where new state sits in its ladder and what happens to it at
  `session_start` (#2649, #2654).
- A measured constant names its measuring command and keeps raw output as a
  tracked artifact pinned by a test (#3648). Run `git check-ignore -v` on every
  new artifact path before citing it (#3648).
- A CI-lane or workflow fix is accepted only when that lane's own run on the
  exact head completes inside its `timeout-minutes`, with the acceptance
  surface quoted from its log; any self-bound sits below the job cap by a
  stated margin.

## Required checks

- Run every test that mocks or deep-equals a changed module or record, and the
  spawn-heavy lanes for real child or LSP tests.
- Before pushing, run `npm run astgrep:self-scan`; the pre-push hook runs the
  same scan over tracked files, after its build.
- Reproduce CI-only failures in the CI command shape.
- Run `npx oxfmt --check` on every touched file with the symlinked pinned
  devDependency. Never `npm install oxfmt --no-save`: it replaces the linked
  `node_modules`.
- Run release-QA end to end when a release-QA row changes.
- Run the reviewer's standing probes (`docs/pi-lens-reviewer.md`) that the diff
  can trip, and quote their output in the PR body.

## Fix rounds

- On `FIX ROUND` findings, reproduce each finding before fixing it, add a
  red-first test for every behavioural fix, rebuild, re-run the targeted suites
  plus anything the findings touched, and push the same branch. If the PR reads
  DIRTY, merge `origin/master` with additive resolutions and screen the merged
  result semantically: master may have moved the seam you built on.
- A reviewer's prescribed remedy is a hypothesis. Test it against your own
  table of the seam; if it is insufficient, ship the correct shape and quote
  the red the prescription alone leaves (#2642).
- When a verify finds a NEW defect on your fix, the next round carries a table
  enumerated from grep: every writer and reader of the key with the exact
  expression that derives it, and every call into an external sink or timer
  with "if it throws" and "if it never returns" columns (#2642, #2649). Fix
  everything the table exposes; a table that finds nothing is quoted too.
- Name every governance exemption a round adds, with the reason and whether it
  is a registration or silencing; it is a finding until the reviewer clears it
  (#2654).
- Spot-check one prior round's mutation on the new head (#2583).
- Re-read the changelog fragment for any claim the round retracts (#3155), then
  add an honest review-round section to the PR body.

## Before the report

Re-climb the minimalism ladder on what you built. Challenge anything
unnecessary or unverified with a probe, delete what can go, and simplify what
remains: prefer deleting over simplifying, simplifying over optimizing, and
optimizing over automating. If the diff survives, leave it alone; churn is not
rigor (#2599).

## Handoff

- The PR body is the whole `.github/PULL_REQUEST_TEMPLATE.md`, every
  heading present in order: `## Why` (one sentence), `## Notes for the
  reviewer`, `## Change outline`, `## Summary`, `## Type of change`,
  `## Area`, `## Checklist`, `## Tests`, `## Blast radius`,
  `## Observability` (a record literal from the runtime diff, `none: <reason>`,
  or exactly `No new failure path; no record added.`, which a new decision
  branch on a session, lifecycle or delivery seam refuses, #3875),
  `## Class sweep`, and `## Test assessment`. A brief that names only some
  headings does not shorten this list. The closing keyword lives in the body;
  GitHub ignores it in a title.
- Run `node scripts/check-pr-body.mjs --lint-local PR_BODY.md` and
  `node scripts/check-changelog-fragments.mjs` before the hand-back; both
  must pass, and the hand-back quotes them. A red `PR body (advisory)` check is
  a fix-before-review item. A changelog fragment is `---` /
  `section: <Added|Changed|Deprecated|Removed|Fixed|Security>` / `---` /
  blank / one `- ` bullet. `npm run changelog:check` checks the rollup, not
  fragments (#2456).
- Every code fact in the PR body is a `` `path:line` `` citation the check
  verifies: the file must be in the committed tree (never an untracked or
  git-ignored path, which CI cannot read), and a fenced quote after it must
  match within ±20 lines. Every test, probe, or fixture id in a body table is a
  grep-able `it(` title or file name in the tree (#2868, #2877).
- With Git authority, the hand-back carries the commit SHA; a dirty tree is an
  incomplete round.
- Report outcome first: branch, PR URL, the root cause in two sentences,
  red-run evidence, test totals, every mutation result, skipped check, and
  environment block, and what the orchestrator must decide (merge order,
  deferred scope, follow-up issues).
