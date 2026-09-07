---
section: Added
---

- **`PreToolUse` Bash guard hook for the fixer/reviewer non-negotiables (closes #2699)** — `scripts/hooks/guard-bash.mjs`, registered in `.claude/settings.json` on the Bash tool, mechanically denies `git stash` in any form, `git reset --soft origin/<branch>` / `--hard`, `git worktree remove` with two force flags, and an unpinned `node` probe against `clients/`/`dist/` with no `PI_LENS_HOME` — the same rules a fixer ran afoul of by hand on 2026-09-07 and 2026-09-02. Never blocks the tool on its own failure: malformed or missing stdin degrades to allow.
