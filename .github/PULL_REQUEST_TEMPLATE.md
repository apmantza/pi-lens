## Summary

Describe what this PR changes, why it changes it, and any non-obvious design
decision or gotcha. Name the issue and explain whether every acceptance
criterion is complete.

Closes #NNN — only when every acceptance criterion is met. Otherwise Refs
#NNN AND comment on the issue naming exactly what remains (deferral hygiene).
The reference must ALSO be in the PR title — the title becomes the
merge-commit subject.

## Type of change

- [ ] Bug fix
- [ ] New feature (net-new capability)
- [ ] Enhancement (improvement to existing capability)
- [ ] Documentation

## Area

- [ ] area:lsp
- [ ] area:dispatch
- [ ] area:installer
- [ ] area:diagnostics
- [ ] area:read-guard
- [ ] area:project-intelligence
- [ ] area:perf
- [ ] area:observability
- [ ] area:session
- [ ] area:config
- [ ] area:security
- [ ] area:tests

## Checklist

- [ ] I have read [CONTRIBUTING.md](../CONTRIBUTING.md) and [AGENTS.md](../AGENTS.md)
- [ ] The change has tests (happy path, edge cases, regression test for bugs)
- [ ] Targeted test files for the touched seams pass locally after `npm run build`; the full suite is CI's job.
- [ ] Every NEW regression test is proven RED on pre-fix code; the red output is quoted in this PR
- [ ] Every new guard/branch/filter is mutation-proof: deleting or neutering it reds at least one test
- [ ] PR title carries the conventional prefix and the issue ref
- [ ] `npm run lint` passes
- [ ] `npm run build:dist` succeeds if I changed code under `clients/`, `commands/`, `tools/`, or `index.ts`
- [ ] `package-lock.json` is in sync with `package.json` (regenerate with the exact npm pin in `package.json`'s `packageManager` field)
- [ ] `AGENTS.md` is updated if this PR changes behavior, commands, conventions, or invariants documented there
- [ ] `.changelog/<branch-or-slug>-<short-desc>.md` has one valid entry **in this PR** for any user-facing change (Added/Changed/Deprecated/Removed/Fixed/Security) — see [.changelog/README.md](../.changelog/README.md); internal-only test/refactor PRs may skip it
- [ ] Commit subject includes the issue number: `(closes #NNN)` or `(refs #NNN)`

## Tests

Name each NEW test file/case and each EDIT of an existing test, with one line
on what it pins and why it exists (regression proof / contract seam /
occupancy budget). If no tests changed, say so explicitly. Prove new
regression tests RED on pre-fix code and quote the output.

Where it is not obvious, name which of AGENTS.md's ten test-authoring screens each new test satisfies (parallel path, invisible skip, wrong-layer pin, ambient-inspection double, env leakage, loose bound, all-mocks, not-throw, implementation mirror, snapshot-as-behavior).

### Test assessment

For each test FILE this PR touches: one line on what behavior that file
uniquely pins, and any test in it this PR makes redundant. Name removal
candidates. A test may be REMOVED only when a named surviving test reds on
the same mutations — demonstrate the redundancy, never assert it. Removal
candidates you do not delete here go to the corpus value ledger issue.

## Blast radius

State affected dependents for each touched production module (from
`module_report` with `blastRadius: true`), callbacks/entry points, and the
verification plan. If a hot path is touched (per-spawn / per-file /
per-render), state the measured cost delta. Record "empty/unavailable"
explicitly with why.

## Observability

Name the log or ledger record that proves this change works in production
(file + event/kind), or name the gap. Docs/test-only PRs may state not
applicable.

## Class sweep

Name the defect class or shape and record a pattern sweep across the WHOLE
tree — `clients/`, `tools/`, `mcp/`, `scripts/`, `index.ts`, never
`clients/` alone — plus a population sweep with a per-member verdict when
the site belongs to an enumerable family. Cite AGENTS.md's defect-shape
catalog. "Class of size 1" requires the grep that proves it. End a
population sweep with a consolidation verdict: fold the family onto one
seam (issue ref) or state why it stays distributed.
