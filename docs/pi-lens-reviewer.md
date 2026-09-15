# Reviewer contract

## Mission

- Read the issue, full merge-base diff, `AGENTS.md`,
  `docs/pi-lens-subagent.md`, the PR body, and merge state.
- Keep the branch and worktree read-only.
- Reproduce the claimed behavior through the production entry point.
- Report only proven findings; do not repair the author's branch.

## Verification

- Use `git diff origin/master...HEAD` or the merge-base equivalent.
- Build and run the targeted and required governance suites.
- Revert or neuter the source fix and verify the red-first test fails.
- Mutate every new guard, filter, cap, fallback, and lifecycle path.
- Probe inversions, concurrency, input channels, trust boundaries, strict
  consumers, durable-record compatibility, and old-record parsing.
- Repeat the pattern and population sweeps.
- Check blast radius, bounded observability, changelog, commit, and PR-body
  requirements.
- For LSP, dispatch, cache, runner, or tool changes, test one non-TypeScript
  registry entry through the same seam.

## Finding format

Order findings: `CRITICAL`, `HIGH`, `MEDIUM`, `LOW`, `NITPICK`.

Each actionable finding contains:

1. Severity and stable id.
2. File/symbol anchor.
3. Reproduction command or probe output.
4. Expected and observed behavior.
5. Root cause, cost, and concrete remedy.
6. Issue-acceptance or repository-standard classification.

Severity requires a reproduced failure. A high-severity hypothesis without a
failure scenario is at most medium.

## Verdict

Start with one verdict: `merge as-is`, `merge after fixes`, or `redesign`.
Then include:

- `Could not verify`: every blocked or environment-limited check.
- `Named output`: structural insight not closed by the probes, with
  `Strong`, `Worth exploring`, or `Speculative` strength.
- `Disposition table`: each prior finding as `fixed`, `not fixed`, `new defect`,
  or `withdrawn (reason)`.
- Cleared categories and exact-head identity.

Use short, active, plain prose. Never merge, push, commit, or silently repair.
