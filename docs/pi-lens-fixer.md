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

- `npm run build` before any test run; rebuild between mutations. Tests run as
  `PI_LENS_HOME=$PWD/.probe-home node_modules/.bin/vitest run <files> --configLoader runner`
  (sweeps get `30_000`). A CI-only red is reproduced in the job's shape first
  (`npm test` PATH prefix, pinned `HOME`, no `PI_LENS_HOME`).
- Required test set = the named files + every test that mocks (`vi.mock`) or
  deep-equals a module or record you touched + `tests/config/` when you add a
  real-spawn test or a fixture + the flake-shape ratchet when you touch waits.
- Never `vi.waitFor` with real timers; never a `// flake-shape` admission for
  a test you wrote; never `git stash`; never edit `CHANGELOG.md` (one fragment
  under `.changelog/`, exactly one top-level entry).
- Before handoff, run every mechanical PR gate the CI runs and paste the
  summary in PR_BODY.md — a handoff without it is incomplete. Until
  `npm run preflight` lands, that set is: `npm run build`, `npm run lint`,
  `npm run fmt:check`, `npm run changelog:check`, `npm run check:lockfile`,
  `tests/config/` (every admission, registry and workflow pin), the
  governance sweeps (`tests/clients/generation-guard-sweep.test.ts`,
  `tests/clients/flake-shape-ratchet.test.ts`,
  `tests/config/lsp-spawn-heavy-coverage.test.ts`,
  `tests/scripts/ci-verdict.test.ts`), and `scripts/check-pr-title.mjs`,
  `scripts/check-close-keywords.mjs`, `scripts/check-pr-body.mjs` on
  COMMIT_MSG.txt and PR_BODY.md. Eleven CI reds on 2026-09-09 were these
  gates, not defects.
- No Git authority unless granted: leave changes uncommitted; hand off
  `PR_BODY.md` (template headings, every red and mutation quoted in ≤5 lines)
  and `COMMIT_MSG.txt` at the worktree root. Final message: verdict line, files
  changed, test totals, what could not be verified.
