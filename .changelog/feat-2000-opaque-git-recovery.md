---
section: Changed
---

- **Opaque-write recovery goes git-first (refs #2000)** — inside a git worktree the pre side records only a timestamp and `git status --porcelain` plus an mtime window answers what changed, with no file-universe cap: recovery now works on any repo size, including large monorepos where the stat-walk previously degraded every command to coverage-unknown. The bounded stat-diff path remains for small non-git trees.
