# Required checks on bot-opened PRs

A pull request that a workflow opens or updates with the repository
`GITHUB_TOKEN` starts no `pull_request` run: GitHub does not let a token-pushed
commit trigger other workflows. Every required check then stays absent and the
PR is BLOCKED until a maintainer closes and reopens it. PR #4945 sat that way
from 2026-10-28 (#5062; #4338 and #2801 before it).

## The mechanism

`workflow_dispatch` and `repository_dispatch` are the two events a
`GITHUB_TOKEN` can start. The job that opens the PR dispatches every workflow
that produces a required check on the branch it just pushed:

```
gh workflow run ci.yml --ref <bot branch>
gh workflow run lint.yml --ref <bot branch>
```

Both workflows carry a `workflow_dispatch` trigger for this. The run is
push-shaped (`scripts/ci-changed-files.mjs` runs the full suite for any event
but `pull_request`), checks out the branch head, and posts the required check
names (`Lint & type-check`, `Unit tests`, `Install test (...)`, `knip`,
`oxfmt format check`, `TLA+ models`, `Unit tests Windows`) on that commit.
Branch protection matches a required check by name and app, not by event, and
`scripts/ci-verdict.mjs` gates a branch-protection name whatever event its run
came from (#4090), so those rows count.

On a bot-opened PR the dispatch runs are the PR's whole CI, so `ci-verdict`
also gates every non-`(advisory)` check from a `workflow_dispatch` run on its
head, such as `Dependency boundaries` and `Production install build`, exactly
as it gates a `pull_request` run. It reads the PR author (the `gh` `is_bot`
flag, an `app/` or `[bot]` login; the REST user type `Bot`). #4090's advisory
rule stays for dispatch runs on a human PR, for a bare-SHA target (no author to
read), and for `schedule`, `workflow_run` and `repository_dispatch` runs on any
PR.

The dispatch step runs when the PR was `created` or `updated` (an unchanged
branch keeps the checks of its last head). It is not `continue-on-error`: a PR
that opened without checks reds the job. When the GitHub App token (#4512)
opened the PR, CI already started and the dispatch is skipped.

## Which workflows open PRs

| Workflow | Job | Branch | Opened with |
| --- | --- | --- | --- |
| `tool-smoke.yml` | `tool-smoke-prs` | `bot/lsp-docs-refresh` | App token when configured, else `GITHUB_TOKEN` |
| `tool-smoke.yml` | `tool-smoke-prs` | `bot/lsp-idle-evict-promote` (draft) | `GITHUB_TOKEN` |

`tests/config/bot-pr-ci-start.test.ts` fails closed on this table: any job that
holds `pull-requests: write`, calls `create-pull-request` or
`create-github-app-token`, or names a PR-creating command must dispatch every
workflow with a `merge_group` trigger on each of its literal branches, or be
registered in that test as a non-opener with its reason.

## Trust boundary

- **Token.** `GITHUB_TOKEN` of the `tool-smoke-prs` job, with `actions: write`
  added beside its existing `contents: write` and `pull-requests: write`. No
  secret, App or personal access token is added; the dispatch step reads
  `secrets.GITHUB_TOKEN` only.
- **Who can run it.** The job runs only on `schedule` or on `master`
  (`tests/config/workflow-writers-governance.test.ts`), so a branch dispatch of
  `tool-smoke.yml` never reaches it.
- **What runs, on which ref.** The dispatched workflow files are those on the
  bot branch. The branch is `master` plus the files the PR step's `add-paths`
  commits (the three LSP docs; for the promotion PR the idle-eviction table,
  its tests and one changelog fragment). `.github/` is never in `add-paths`, so
  the dispatched workflow files equal master's. The promotion PR changes
  `clients/lsp/server.ts` and tests, which CI then runs: the same code a
  same-repository `pull_request` run of that PR would run, with the permissions
  `ci.yml` and `lint.yml` declare per job (read scopes; `ci.yml` uses no
  secret beyond `GITHUB_TOKEN`).
- **Dispatch from any ref.** `ci.yml` and `lint.yml` are now dispatchable by
  anyone with write access on any branch. Their jobs hold read scopes only,
  except the PR-only CodeQL job (`security-events: write`), whose job-level
  `if` requires a `pull_request` event and so never starts on a dispatch
  (`scripts/dispatch-safety.mjs` reads that conjunct as a guard).
- **Step order.** Both dispatch steps close the `tool-smoke-prs` job, so a
  failed `gh workflow run` never skips the auto-merge disarm failsafe or the
  promotion PR (every other step there runs under an implicit `success()`).
  Each dispatch's status check follows from what its PR's failsafe needs. The
  docs-refresh dispatch keeps the implicit `success()`: a failed disarm
  withholds CI, so an auto-merge armed on an earlier night cannot merge a
  refresh with flips. The promotion dispatch runs under `!cancelled()`: only
  the docs-refresh dispatch sits between its PR step and it, and a failure
  there must not skip it. `tests/config/bot-pr-ci-start.test.ts` derives the
  form per PR step: any non-dispatch step after the PR step means the
  implicit `success()`, and only dispatch steps mean `!cancelled()`. It
  refuses every other form, a step after the first dispatch, a dispatch
  before its PR step, and a dispatch step whose run is anything but
  `set -euo pipefail` and one `gh workflow run` per target.
- **Not covered.** A dispatched run is not a `pull_request` run: it tests the
  branch head, not the merge with master, and the PR-only advisory jobs (the
  changelog fast-fail, targeted tests, CodeQL, the PR body lint) do not run.
  `ci-infra-kill-rerun.yml` reacts to `pull_request` and `push` runs only, so a
  runner kill on a dispatched run is re-run by hand.

## Why not an App token only

#4512 already mints an App installation token for the docs-refresh PR when
`LSP_REFRESH_APP_ID` is set, and the promotion PR deliberately keeps
`GITHUB_TOKEN`. The App route needs a repository variable and secret that are
not configured, and widening the promotion PR to it would add a credential.
The dispatch needs neither and covers both PRs; the App token still wins for
the docs-refresh PR when present, because a native `pull_request` run also
tests the merge with master.
