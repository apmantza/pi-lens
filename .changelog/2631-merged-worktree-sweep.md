---
section: Fixed
---

- **Prune merged clean worktrees with a per-run cap; never a tree with untracked files (refs #2631, #2538, #2784)** — the agent-worktree hygiene sweep now also removes any registered worktree whose branch tip is an ancestor of `origin/master` and whose checkout is clean, clears `.claude/worktrees/agent-*` leftovers that hold nothing but git's own `.git` gitlink, and caps removals per run with `--max` (default 10). An untracked file counts as a deliverable: only an empty `git status --porcelain` is clean, and the keep record names the first entry it protected.
