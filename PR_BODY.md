Closes #2993
Refs #2856

## Summary

Keep fork pull requests from failing on token-capped metadata writes. Make stale verdict-label cleanup advisory, skip it for fork heads, and run merged-PR close-keyword comments on pull_request_target.

## Premise

I confirmed origin/master at c48cef3df before editing. The real workflow had workflow_run and pull_request types synchronize, a cleanup job declaring pull-requests write, and gh pr edit removing ci:infra and ci:real.

The required live log read was gh run view --job 103506690784 --log for run 34640508457. It reported:

```text
GITHUB_TOKEN Permissions
Metadata: read
PullRequests: read
GraphQL: Resource not accessible by integration (removeLabelsFromLabelable)
##[error]Process completed with exit code 1.
```

The local verdict read was PI_LENS_HOME=$PWD/.probe-home node scripts/ci-verdict.mjs 2983:

```text
Clear stale CI verdict labels completed failure
gating check(s) completed with a non-success conclusion: Clear stale CI verdict labels (failure)
exit_code=1
```

The same verdict listed Classify failed Unit tests and Finalize CI rerun classification as completed/skipped. Both jobs have no needs dependency on cleanup; their own if expressions require github.event.workflow_run.head_repository.full_name == github.repository. Therefore fork workflow_run events are excluded by those guards. This is not a dependency cascade, and the #2042 fork rerun lane remains a separately tracked limitation.

## The fix

The cleanup job now requires a same-repository PR head and is explicitly listed as advisory with a reason beside the neighboring entries. This cures the general defect: label bookkeeping cannot block correctness, including same-repository API failures or absent labels. It also makes the fork token cap an intentional skip; stale fork labels are acceptable because they do not affect merge correctness and no write-capable fork cleanup is available on this trigger.

Merged-PR close-keyword verification now uses pull_request_target, whose token is not fork-capped. This cures the sibling write exposure while preserving verification comments. I rejected a silent continue-on-error because it would hide a visible failure, and rejected fork-guarding close-keyword verification because it would remove a correctness check rather than move its write to an uncapped context.

## Class sweep

I swept .github/workflows/** with:

```text
rg -n "gh (pr|issue) (edit|comment|merge)|gh api|actions/github-script|repo_token:|token:|GITHUB_TOKEN|curl ... --request (POST|PATCH|PUT|DELETE)" .github/workflows
```

Members and verdicts:

- ci-infra-kill-rerun.yml:clear-stale-verdict-labels: pull_request write, fixed by fork guard and advisory entry.
- ci-infra-kill-rerun.yml:classify and finalize-rerun: writes only on workflow_run, which is uncapped; clean.
- close-keyword-verification.yml:verify: merged-PR comment write, moved from pull_request to uncapped pull_request_target.
- ci.yml:record-post-merge-validation and lint.yml:record-post-merge-validation: writes only on repository_dispatch; clean.
- greetings.yml:greeting: already advisory-listed and uses pull_request_target; confirmed cleared.
- close-keywords.yml:lint, mutation.yml:mutation, and the remaining pull_request jobs: reads or test execution only; clean.

The consolidation verdict is to stay distributed at workflow boundaries. A shared helper would relocate YAML trigger and permission semantics into callers, while the single advisory policy seam already centralizes the gating decision. The governance test is the shared recurrence screen; individual workflows retain their security-specific trigger guards.

## Tests

The new test file is tests/config/github-token-write-gates.test.ts. It scans all workflow jobs, uses the existing stripSource seam to blank comments and strings, checks accept and reject directions, and names #2993 and the fork-token cap in its guard comment.

Red-first, before the fix, after `npm run build`:

```text
FAIL tests/config/github-token-write-gates.test.ts
fork-capped token writes must be contained: ["ci-infra-kill-rerun.yml:clear-stale-verdict-labels (Clear stale CI verdict labels)"]
test_exit_code=1
```

Fork-guard mutation: removed the head-repository conjunct, rebuilt, and ran the new file:

```text
FAIL ... skips cleanup when the synchronize PR head is a fork
Expected: github.event.pull_request.head.repo.full_name == github.repository
Received: github.event_name == 'pull_request' && github.event.action == 'synchronize'
test_exit_code=1
```

Target-trigger mutation: changed pull_request_target back to pull_request, rebuilt, and ran the new file:

```text
FAIL ... runs merged-PR comment verification on the uncapped target trigger
Expected: defined
Received: undefined
test_exit_code=1
```

The fixed governance file passed 5 tests. The complete config lane passed 54 files and 475 tests, with 1 skipped. The existing `tests/config/ci-infra-kill-rerun-gate.test.ts` passed its workflow expression and cleanup contracts.

## Blast radius

```text
Gating verdict
  resolve check-run name
  + isAdvisoryCheck("Clear stale CI verdict labels")
    ADVISORY_CHECKS
      + "Clear stale CI verdict labels"

Workflow execution
  pull_request synchronize
    clear-stale-verdict-labels
      + same-repository head guard
      gh pr edit --remove-label
  pull_request_target closed
    verify
      check-close-keywords.mjs --verify-merged
      + writable target token
```

No production client call graph changed. Affected consumers are CI check-run verdict resolution, the cleanup workflow, and merged-PR close-keyword verification.

## Observability

No new failure path; no record added. The existing check conclusion remains visible, while advisory classification prevents metadata failure from entering the gating verdict.

## Test assessment

The new governance test observes real workflow YAML and the real advisory set. It does not replace an in-process collaborator with a mock. The reject twin prevents an unrelated unguarded write from passing, and the two source mutations produced compile-valid red runs.

## Verification

- git rev-parse HEAD and git rev-parse origin/master: exit 0; identical base before edits.
- git fetch origin and git log -1 --oneline origin/master: exit 0; c48cef3df.
- npm run build: exit 0 before each test phase and mutation.
- PI_LENS_HOME=$PWD/.probe-home node_modules/.bin/vitest run tests/config/github-token-write-gates.test.ts --configLoader runner: exit 0; 5 tests passed.
- PI_LENS_HOME=$PWD/.probe-home node_modules/.bin/vitest run tests/config --configLoader runner: exit 0; 54 files, 475 passed, 1 skipped.
- npx tsc --noEmit: exit 0.
- npm run fmt:check: required after formatting.
- npx markdownlint-cli2 --no-globs AGENTS.md: exit 0.
- actionlint over both changed workflows: unavailable (command absent), exit 127.
- PI_LENS_HOME=$PWD/.probe-home npm run preflight: launched last; the runner returned no final exit line after the process completed, so its exit code could not be captured.

## Skipped and remaining confirmation

The full 1,095-file population was not run because this change touches CI configuration and governance tests only; the required tests/config mechanical lane is the relevant population. The live GitHub acceptance verdict on a fixed fork head, exact-head CI, and merge-gate execution remain for the orchestrator after push.
