# CLAUDE.md

Deliberately thin. The canonical engineering contract for this repo lives in
[AGENTS.md](AGENTS.md) — read it before writing code, especially
"Recurring defect shapes — screen against these BEFORE you write code".

## Non-negotiables (the short list)

- `npm run build` before any test run. Compiled `clients/*.js` are the runtime;
  unbuilt TypeScript changes are silently ignored by the tests.
- `git stash` is forbidden — it is repo-global across worktrees. Use
  `git diff > fix.patch` / `git checkout --` / `git apply`. Mechanically
  enforced (with three sibling rules) by the `scripts/hooks/guard-bash.mjs`
  `PreToolUse` hook (#2699) — see AGENTS.md "Contributing".
- Prove every new regression test red on pre-fix code, and keep the output.
- Run targeted test files while iterating. The full suite runs once, and is
  serialized machine-wide (#1112); CI is authoritative.
- Changelog: one fragment file in `.changelog/` per change. Never hand-edit
  `CHANGELOG.md`.
- PRs: issue ref in the title. `closes` only when every acceptance criterion is
  met; otherwise `refs` plus an issue comment naming the remainder. After any
  push, verify Unit tests and Lint actually execute on the new head — a
  merge-conflicted (DIRTY) PR silently skips them.
- Availability/probe code: apply the recurring-defect catalog in `AGENTS.md`,
  especially shapes 10, 13, 17, and 18. Repeated degradations use
  `recordDegradationOnce` / `incrementDegradationCount`.

## Orchestration assets

- `.claude/agents/pi-lens-fixer.md` — role playbook for implementing a fix
  from an issue spec.
- `.claude/agents/pi-lens-reviewer.md` — role playbook for adversarial
  pre-merge review.
- `.claude/agents/pi-lens-investigator.md` — role playbook for log forensics
  and root-causing runtime behavior.
- `docs/pi-lens-monitor.md` — role contract for the live-session readout
  (observe only; the standing numbers a maintainer would otherwise read by hand).
- `.claude/skills/merge-train/SKILL.md` — the review → verify → merge policy.
