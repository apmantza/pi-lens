# Fixer contract

Deliver a root-caused fix with red proof and a reviewable handoff.

Read the issue, repository instructions, shared delegated worker contract, and
relevant architecture before editing. Reuse the shared seam and existing
machinery. Keep the change localized and compatible with concurrent branches.

Build the smallest faithful reproduction first. Preserve its pre-fix failure
output. After fixing, prove every new guard mutation-sensitive. Run a pattern
sweep and a population sweep for the defect class. Record per-member verdicts,
the blast radius, and bounded observability. Add a changelog fragment for a code
change.

## Tautological tests considered harmful

Do not assert a value that the test setup already supplied, duplicate the source
predicate in the test, or replace a real in-process seam with a fake to keep the
test green. Drive the production path and assert an independent observable. If
the test passes after deleting the guard, it is tautological and must be
redesigned before the fix is complete.

Verify the build and every targeted or sibling suite required by repository
policy. Follow the shared contract's Git authority. Report what ran, what was
skipped, and why. Use active, plain prose.

## Standard mechanics (apply unless the brief overrides)

A fix on `clients/lsp/`, the read guard, tool registration, or session lifecycle adds or updates a real-harness scenario when the defect is only observable through the host; the scenario is the red-first proof where a unit seam cannot show it.

- Every language pi-lens supports (`LANGUAGES` in `clients/language-registry.ts`),
  never one: a fix on an LSP, dispatch, cache or tool seam is stated in
  language-neutral terms, names which registry entries carry the facts it
  needs and which fall to the honest fallback, and its test matrix has at
  least one non-TypeScript row (catalog shape 42).
- `npm run build` before any test run; rebuild between mutations. Tests run as
  `PI_LENS_HOME=$PWD/.probe-home node_modules/.bin/vitest run <files> --configLoader runner`
  (sweeps get `30_000`). A CI-only red is reproduced in the job's shape first
  (`npm test` PATH prefix, pinned `HOME`, no `PI_LENS_HOME`).
- When a task regenerates `package-lock.json`, use the exact npm version in
  `package.json`'s `packageManager` field, which is also the CI production-install pin.
- Required test set = the named files + every test that mocks (`vi.mock`) or
  deep-equals a module or record you touched + `tests/config/` when you add a
  real-spawn test or a fixture + the flake-shape ratchet when you touch waits.
- Never `vi.waitFor` with real timers; never a `// flake-shape` admission for
  a test you wrote; never `git stash`; never edit `CHANGELOG.md` (one fragment
  under `.changelog/`, exactly one top-level entry).
- Every test id, probe id or fixture name you write into a PR-body table
  (state-space, writers-by-axis, population) must exist as a grep-able `it(`
  title or file name in the tree at handoff. The orchestrator greps each id
  before accepting the round; a table whose ids do not exist is a fabricated
  claim and fails the round (2026-09-10: #2877 r3 and #2868 r3 each shipped a
  48- to 72-cell table with zero real ids).
- A claim about the HOST or the ENVIRONMENT is a transcript, not a sentence.
  "pi does not re-run the factory on resume", "this failure is pre-existing on
  master", "the harness cannot fire that event" — each carries the command and
  output that measured it in the same environment (a probe extension against
  real pi in rpc mode; the same test file run on origin/master in the same
  tree). 2026-09-10: three rounds on #2866 and #2878 were built on unmeasured
  host claims the verify overturned, and "pre-existing analyze-cli red" was
  reported by four workers whose sandbox differed from CI and master.
- When a fix is a RULE (a scanner's scope rule, a lifecycle rule, a
  classification), derive it from the source of truth and enumerate from
  there — the tree-sitter grammar table, pi's pinned event types measured
  live, the client's real return sites — never from a hand-written list of
  the cases the reviewer named. Seven rounds on #2877 each closed the named
  launderer and left the next scope kind open until round 4 generated the
  scope table from the grammar.
- A change to a release-QA row (`docs/release-qa-baseline.md` +
  `scripts/release-qa.mjs`) runs `node scripts/release-qa.mjs` end to end
  once on the pushed head and quotes the verdict line in the body; the
  row↔probe tie test cannot see a row that never passes (#2893).
- Before handoff, run `npm run preflight` last and paste its table in
  `PR_BODY.md` — a handoff without it is incomplete.
- One set of template headings per PR. A fix round APPENDS `## Round N` and
  edits the existing `## Observability` / `## Tests` sections in place; it
  never adds a second `## Observability` (the lint reads the first one, and a
  stale first section was the most common `PR body` red on 2026-09-10). Lint
  the FULL body you will publish (`gh pr view <n> --json body -q .body` plus
  your round), against the real `origin/master...HEAD` diff (fetch first),
  not a hand-shaped diff.
- `PR_BODY.md` passes `node scripts/check-pr-body.mjs --lint-local PR_BODY.md`
  before handoff. The gate requires the headings `## Summary`, `## Tests`,
  `## Blast radius`, `## Class sweep`, `## Observability`, and
  `## Test assessment` whenever the diff touches `tests/`; Observability
  names a record literal that appears in the runtime diff, and may say
  exactly "No new failure path; no record added." only when the diff adds no
  failure path (no new catch, fallback or degradation branch). Every code fact
  is a citation the check verifies. Record: on
  2026-09-10 most open PRs failed the PR-body check on one of these two rules.
- No Git authority unless granted: leave changes uncommitted; hand off
  `PR_BODY.md` (template headings, every red and mutation quoted in ≤5 lines)
  plus two optional one-liners the reviewer reads first: `Operating rule:`
  (the one sentence the change enforces) and `Kept:` (what was deliberately
  not changed, so a reviewer does not re-litigate it);
  and `COMMIT_MSG.txt` at the worktree root. Final message: verdict line, files
  changed, test totals, what could not be verified.
