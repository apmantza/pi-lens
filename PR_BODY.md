## Summary

Round 3 merges `origin/master`, preserves the preflight local-input contract, and restores the shared `gitExecFileSync` seam so the observability diff is acquired.

## Round 3

- F1: fixed in round 2. CI uses a full checkout and reports `diff unavailable:` when the ref is absent.
- F2: fixed in round 2. Test, `__tests__`, and declaration files are excluded from runtime marker checks.
- F3: fixed in round 2. Comment and template-literal laundering cases fail, including the blanking mutation.
- F4: fixed. The merge keeps master's `--lint-local PR_BODY.md` invocation from `scripts/pr-preflight.mjs` and this PR's `--body <body> --title <title>` title-aware variant.
- F5: fixed. `localDiff()` uses the master's `gitExecFileSync` wrapper, which calls `execFileSync("git", args, options)`.

The pre-fix red was `The "file" argument must be of type string. Received an instance of Array`.
The pre-fix local live-path probe returned `{"valid":true,"errors":[]}` for a runtime-shaped body with no record.

## Tests

- `tests/scripts/check-pr-body.test.ts`: added full-checkout diff acquisition and runtime missing-record regressions, and updated the local fallback matrix for the merged seam.
- `tests/clients/flake-shape-ratchet.test.ts`: ran unchanged to verify the existing admission population.
- `tests/scripts/check-pr-body.test.ts` and `tests/clients/flake-shape-ratchet.test.ts`: 148 tests passed.
- `npm run build`: passed.
- Full-checkout probe: acquired 17,952 bytes from `origin/master...HEAD`.
- Shallow-clone probe: reports `diff unavailable:` only when `origin/master` is absent in CI mode.
- `npm run preflight`: run below; its table is the final verification record.

Final preflight table:

| gate | mirrored CI job | pass/fail | first red line |
| --- | --- | --- | --- |
| build | Lint & type-check | pass | |
| lint | Lint & type-check | pass | |
| fmt:check | oxfmt format check (advisory) | FAIL | `tests/clients/dispatch/runners/eslint.test.ts` |
| changelog:check | Unit tests | pass | |
| check-changelog-fragments | Changelog fragment (fast-fail) | pass | |
| check:lockfile | Lint & type-check | pass | |
| tests/config | Unit tests | pass | |
| generation-guard | Unit tests | pass | |
| flake-shape-ratchet | Unit tests | pass | |
| lsp-spawn-heavy-coverage | Unit tests | pass | |
| ci-verdict | Unit tests | pass | |
| check-pr-title | PR title | pass | |
| check-close-keywords | Close-keyword syntax | pass | |
| check-pr-body | PR body (advisory) | pass | |

`fmt:check` reports seven master ratchet-sensitive mock files. Formatting them changes the vi-mock detector shape and makes `tests/config` fail; master itself carries this conflict.

## Blast radius

The changed seam is `localDiff()`.

```text
lintPullRequestEvent
  localDiff
    + gitExecFileSync
      execFileSync("git", args, options)
lintLocalPrBody
  localDiff
  localTouchesTests
```

The seam affects live PR lint and local preflight. The CLI keeps both local-input forms. #2814 also touches `tests/clients/flake-shape-ratchet.test.ts` and the admission baseline near this PR's rows; this PR keeps its admission entries minimal and does not expand that population.

## Class sweep

The sweep covered `localDiff`, `lintLocalPrBody`, `localTouchesTests`, both CLI forms, the live caller, the shallow fallback, and the flake-shape admission rows. The consolidation verdict is to keep one process seam, `gitExecFileSync`, because both live and local callers require the same Git environment sanitization.

## Observability

CI still fails loudly with the bounded `diff unavailable: <reason>` diagnostic when the upstream ref is truly absent. A successfully acquired diff now reaches the runtime observability rule in both live and local paths.

### Test assessment

The tests use the real checker, Git process seam, full checkout, and real shallow clone. The injected Git callback is limited to deterministic local matrix cases; it does not replace the in-process checker.
