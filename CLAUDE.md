# CLAUDE.md

Read the engineering principles (in your global instructions; vendored at
`docs/engineering-principles.md`), then the contract, [AGENTS.md](AGENTS.md),
starting with its "Recurring defect shapes" index and the entries it points at
(`docs/defect-shapes.md`); the standing invariants live under `docs/invariants/`.
Claude Code does not load AGENTS.md automatically; this file carries only what
precedes that read.

- `npm run build` before any test run; tests execute the compiled twins
  (`npm run build:dist` too for the census files that read `dist/`).
- `scripts/hooks/guard-bash.mjs` (`PreToolUse`) denies writing `git stash`
  forms (`git stash list` / `show` pass), hook bypasses, and the rest of
  AGENTS.md "Contributing". Fix the command; never route around it.
- Role contracts are `docs/pi-lens-*.md`, the only home of role rules;
  `.claude/agents/` holds thin Claude wrappers, `.claude/skills/` the retro
  procedure, and `docs/pi-lens-merge-policy.md` the merge policy.
