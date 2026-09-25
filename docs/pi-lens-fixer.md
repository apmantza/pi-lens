# Fixer contract

## Mission

- Read the issue, `AGENTS.md`, `docs/pi-lens-subagent.md`, and this contract.
- Trace the production entry point before naming a seam.
- Reproduce the defect on the current tree.
- Before writing the fix, or a unit tested in isolation, list the ways it can
  fail (inputs, states, orderings, platforms) in the PR body; a space with two
  axes is a table. The tests cover that list, not only the happy path.
- Implement the smallest root-caused fix.
- Preserve contributor authorship and leave Git authority to the orchestrator
  unless the delegation grants it explicitly.

## Standing procedure

### Standard mechanics

- Commit the code as soon as the targeted suite is green, then add evidence in
  a later commit. A worker can be settled mid-evidence-pass; on PR #3268 the
  orchestrator had to commit the tree.
- A whole-module `vi.mock` of a production module must spread `importOriginal`.
  Run `tests/config/vi-mock-export-sweep.test.ts`.
- Exact-pin sweeps and merge state: `tests/config/glossary-synonym-sweep.test.ts`
  (#3279) pins the live retired-synonym identifier population per (term, file)
  exactly, in both directions. If a change adds or removes one of the pinned
  identifier uses, run the sweep on the head and on the merge of
  `origin/master` + head before pushing, then re-pin in the same PR using the
  sweep's own `UNPINNED`/`STALE` output. On 2026-09-23, two green PRs merged
  red (#3279's pins predated #3283, leaving master red until #3288), and #3284
  was red on its own `path` count changes (cue-vet 5→6, dart-analyze 6→4)
  until an orchestrator trailing commit re-pinned.

### Failure list before code

Before the first edit of any fix, write the list of ways the change could fail
(the directions the mutation table will later prove) in the PR body. The
mutation table is that list with transcripts, never a list invented after the
code. This week's evidence: #3252 r1 shipped an exit table whose inverse
direction (nonzero WITH findings) was never listed and was caught by the
reviewer.

Seams are named in the brief before the round; no test is written at an
unconfirmed seam — a fixer that needs a new seam stops and reports it as a
finding, not as a test.

A fix round does not deepen: no refactor, no helper extraction, no rename
beyond the fix's own lines; deepening is its own slice under the owning
umbrella. #3254 and #3256 stayed inside their briefs; #3178's four rounds show
the cost of not doing so.

## Evidence

- Witness rule (ADR 0007): #1605 owns the witness lanes, and their fixtures
  live under `tests/fixtures/witness/<slice>/`.

- Add a regression test through the production path.
- Capture the pre-fix assertion failure.
- Prove the fixed test passes.
- Mutate or remove every new guard, branch, filter, cap, and fallback; quote the
  compile-valid red result.
- Sweep the whole codebase for the defect shape and every enumerable member.
- Record per-member verdicts, blast radius, affected callers, and bounded
  observability.

## Required checks

- Run `npm run build` before tests and rebuild between mutations.
- Run targeted tests through the repository's pinned environment. Include every
  test that mocks or deep-equals a changed module or record.
- Add `tests/config/` and spawn-heavy lanes for real child or LSP tests.
- Reproduce CI-only failures in the CI command shape.
- Use the exact npm pin in `package.json` for lockfile changes.
- Add one `.changelog/<slug>.md` fragment for code changes. Never edit
  `CHANGELOG.md`.
- Run release-QA end to end when a release-QA row changes.

## Test screens

- Enter through the real production function.
- Do not use setup-echoing, implementation-mirroring, or mock-only assertions.
- Do not use ambient stack/caller inspection in doubles.
- Restore env, timers, cwd, and module state.
- Make skips explicit and visible.
- Use independent expected values and behavioral assertions.
- Keep timing bounds near measured fixed and regressed values.
- Make every PR-body test id grepable in the tree.

## Handoff

- Without Git authority, leave changes uncommitted.
- Write root-level `PR_BODY.md` and `COMMIT_MSG.txt`; keep both untracked.
- The PR body is the whole `.github/PULL_REQUEST_TEMPLATE.md`, every
  heading present in order: `## Why` (one sentence), `## Notes for the
  reviewer`, `## Change outline`, `## Summary`, `## Type of change`,
  `## Area`, `## Checklist`, `## Tests`, `## Blast radius`,
  `## Observability` (a record literal from the runtime diff, or exactly
  `No new failure path; no record added.`), `## Class sweep`, and
  `## Test assessment`. A brief that names only some headings does not
  shorten this list.
- Run `node scripts/check-pr-body.mjs --lint-local PR_BODY.md` and
  `node scripts/check-changelog-fragments.mjs` before the hand-back; both
  must pass, and the hand-back quotes them. A changelog fragment is
  `---` / `section: <Added|Changed|Deprecated|Removed|Fixed|Security>` /
  `---` / blank / one `- ` bullet. (Four of six Luna PRs on 2026-09-23
  redded the PR-body and changelog gates on the first head; the fixes were
  all mechanical.)
- Every code fact in the PR body is a `` `path:line` `` citation the check
  verifies: the file must be in the committed tree (never an untracked or
  git-ignored path, which CI cannot read), and a fenced quote after it must
  match within ±20 lines. Prose about code with no citation is unverified.
- The hand-back carries the commit SHA; a dirty tree is an incomplete
  round.
- Include every red, mutation result, skipped check, and environment block.
- Answer each finding id with `fixed`, `not fixed`, or `withdrawn (reason)`.
- Report verdict, changed files, totals, and unverifiable checks.
