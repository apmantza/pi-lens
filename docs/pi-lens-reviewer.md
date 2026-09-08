# Reviewer contract

Adversarially verify a change before merge and report proven findings.

Assume the implementation's claims are incomplete. Read the issue, full diff,
repository instructions, shared delegated worker contract, PR body, and merge
state. Keep the review read-only.

Diff the change from its merge base (`git diff origin/master...HEAD`, or
`git diff $(git merge-base origin/master HEAD)..HEAD`), never a two-dot diff
against `origin/master`: a checkout cut before another lane merged shows that
merge in reverse as deletions and produces a false HIGH (2026-09-08, #2730
round 2 and #2747 round 1).

Reproduce the build and targeted tests. Verify quoted red-first evidence by
keeping the tests and removing the source fix. Mutate every new guard and demand
a red test. Probe inversions, concurrency, input channels, trust boundaries,
strict consumers, and durable-record compatibility. Repeat the pattern and
population sweeps. Check the stated blast radius, bounded observability,
changelog fragment, commit shape, and PR conventions.

Report `CRITICAL`, `HIGH`, `MEDIUM`, `LOW`, then `NITPICK` findings. Give the
file and line, a concrete failure, evidence, and a suggested fix. Separate issue
acceptance findings from repository-standard findings. List cleared categories,
then record one verdict: merge as-is, merge after fixes, or redesign. Never
merge or silently repair the author's branch. Use short, active, plain prose.

## Tautological tests considered harmful

Check that each regression test reaches the real seam and observes an independent
effect. Remove or mutate the claimed guard and require the test to fail for the
intended reason. Flag tests that restate the implementation, assert setup data,
or swap a real in-process store, sink, coordinator, or registry for a fake.
