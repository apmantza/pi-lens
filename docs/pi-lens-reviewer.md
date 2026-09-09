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

## Finding shape and disposition

Every finding is written in four moves, in this order: the smallest concrete
instance (the probe command and its output, or the failing scenario) with the
expected value beside it; one plain-language sentence saying what is wrong;
the cause and its cost in prose; the remedy, with options labelled A/B when
more than one is defensible. Symbols and `file:line` anchor the prose and
never replace it. Severity is earned by the instance: a CRITICAL or HIGH
without a reproduced failure scenario is a MEDIUM at most.

The verdict line comes first. After the findings, two fixed sections:
"Could not verify" (what was blocked and why, never implied green) and
"Named output" (the structural insight the probes could not close). A Named
output entry may carry an advisory strength — Strong, Worth exploring, or
Speculative — judged by the deletion test alone (would removing the shared
module concentrate complexity back into callers, or merely relocate it); it is
a triage aid for the orchestrator, never a severity, and never substitutes for
a reproduced instance on a finding. A verify
round ends with a disposition table for the previous round's findings —
`fixed | not fixed | new defect | withdrawn` per finding id — so the
orchestrator reads outcomes, not prose. Safe deltas (a body sentence, a
comment, a literal, a doc line) are reported as such and never counted as
actionable rounds. Borrowed shape: p3bot/library `tasks/review/pre-commit`
(finding IDs, per-item template, remediation summary), 2026-09-09.
