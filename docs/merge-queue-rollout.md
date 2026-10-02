# Merge queue rollout

Adopting GitHub's merge queue for `master` (#3754). The repository side is in
the same change as this page; the settings below are the maintainer's step and
are deliberately not applied by any script or workflow.

## Why

Every master move forced `gh pr update-branch` and a full CI re-run on every
open PR. A queue tests each PR merged onto the latest master, in order, so
neither is needed. Sharded Unit tests (#3753) keep one queue run short.

## Repository side (already in this change)

- `ci.yml` and `lint.yml` run on `merge_group` (`types: [checks_requested]`).
  Together they produce every required check: `Lint & type-check`,
  `Unit tests`, `Install test (ubuntu-latest)`, `Install test (windows-latest)`,
  `Install test (macos-latest)`, `knip`, `oxfmt format check`, `TLA+ models`.
- PR-only jobs (PR title, PR body, changelog fast-fail, targeted advisory) are
  guarded by `github.event_name == 'pull_request'` and are skipped on
  `merge_group`; none of them is required.
- `tests/config/merge-queue-workflows.test.ts` pins the trigger, the required
  job names, and that no required job (or a job it `needs:`) is gated off on
  `merge_group`.
- `scripts/ci-verdict.mjs` reports a queued PR as kind `in-queue` (exit 3) and
  a failed queue run as a FAIL event; the warden never update-branches a PR in
  the queue or anywhere master has a queue.

## Maintainer settings (Settings, Rules, Rulesets, New branch ruleset)

| Setting | Value | Why |
| --- | --- | --- |
| Ruleset name | `master merge queue` | |
| Enforcement status | Active | |
| Target branches | Include default branch (`master`) | |
| Require status checks to pass | the eight names above, source GitHub Actions | unchanged from branch protection today |
| Require branches to be up to date | off | the queue replaces it |
| Require merge queue | on | |
| Merge method | Merge commit | repo convention (`gh pr merge --merge`) |
| Build concurrency (maximum pull requests to build) | 3 | queue builds run three required-check sets at once on hosted runners |
| Minimum pull requests to merge | 1 | never hold a green PR waiting for company |
| Maximum pull requests to merge | 3 | a failing group costs at most three re-tests |
| Wait time to meet minimum group size | 1 minute | |
| Only merge non-failing pull requests | All commits must pass (`ALLGREEN`) | a red group member ejects only itself |
| Status check timeout | 30 minutes | the required set took about 10 minutes at the median and about 12 at the maximum over 30 runs before sharding; 30 minutes is 2.5x that |

Branch protection on `master` today is classic (no ruleset exists).
`scripts/ci-verdict.mjs` reads the live required-check names from classic
branch protection; if you move the required checks into the ruleset it falls
back to the static list (`Unit tests`, `Lint & type-check`) and still gates on
every non-advisory check-run it discovers. Either keep the classic rule
(enable "Require merge queue" there) or accept the narrower absent-check
detection.

## Rollout steps

1. Merge #3753 (sharded Unit tests) first, then this change.
2. Create the ruleset above.
3. Enqueue one low-risk PR: `gh pr merge <N> --merge`.
4. Confirm in `gh run list --event merge_group` that `CI` and `Lint` ran on the
   `gh-readonly-queue/master/pr-<N>-<sha>` ref and that all seven required
   checks reported there. A required check that never reports stalls the queue
   until the 30-minute timeout.
5. Stop using `gh pr update-branch` and "re-arm" pushes; both are moot and a
   push to a queued PR ejects it.

## Rollback

Disable the ruleset's "Require merge queue" rule. PRs merge directly again;
nothing in the repository needs reverting, because `merge_group` triggers and
the ci-verdict queue reads are inert without a queue.

## Known remainder

The `train:approved` lane that merged through the REST merge API was retired
(#3837), so no competing lane holds a merge the queue would refuse. Every
merge goes through `gh pr merge` (auto-merge or direct), which the queue
intercepts when the base branch requires one.
