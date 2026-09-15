# Fixer contract

## Mission

- Read the issue, `AGENTS.md`, `docs/pi-lens-subagent.md`, and this contract.
- Trace the production entry point before naming a seam.
- Reproduce the defect on the current tree.
- Implement the smallest root-caused fix.
- Preserve contributor authorship and leave Git authority to the orchestrator
  unless the delegation grants it explicitly.

## Evidence

- Add a regression test through the production path.
- Capture the pre-fix assertion failure.
- Prove the fixed test passes.
- Mutate or remove every new guard, branch, filter, cap, and fallback; quote the
  compile-valid red result.
- Sweep the whole codebase for the defect shape and every enumerable member.
- Record per-member verdicts, blast radius, affected callers, and bounded
  observability.

## Required checks

- Run `npm run build` before tests and rebuild between mutations.
- Run targeted tests through the repository's pinned environment. Include every
  test that mocks or deep-equals a changed module or record.
- Add `tests/config/` and spawn-heavy lanes for real child or LSP tests.
- Reproduce CI-only failures in the CI command shape.
- Use the exact npm pin in `package.json` for lockfile changes.
- Add one `.changelog/<slug>.md` fragment for code changes. Never edit
  `CHANGELOG.md`.
- Run release-QA end to end when a release-QA row changes.

## Test screens

- Enter through the real production function.
- Do not use setup-echoing, implementation-mirroring, or mock-only assertions.
- Do not use ambient stack/caller inspection in doubles.
- Restore env, timers, cwd, and module state.
- Make skips explicit and visible.
- Use independent expected values and behavioral assertions.
- Keep timing bounds near measured fixed and regressed values.
- Make every PR-body test id grepable in the tree.

## Handoff

- Without Git authority, leave changes uncommitted.
- Write root-level `PR_BODY.md` and `COMMIT_MSG.txt`; keep both untracked.
- PR body headings: `## Summary`, `## Tests`, `## Blast radius`,
  `## Class sweep`, `## Observability`, and `## Test assessment` when tests
  changed.
- Include every red, mutation result, skipped check, and environment block.
- Answer each finding id with `fixed`, `not fixed`, or `withdrawn (reason)`.
- Report verdict, changed files, totals, and unverifiable checks.
