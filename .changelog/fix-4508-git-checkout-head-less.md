---
section: Fixed
audience: user
---

- **A stray `.git` directory no longer becomes the checkout root (closes #4508)** — The file walk behind checkout, linked-worktree and HEAD lookups now skips a `.git` directory with no `HEAD`, as git does, and keeps looking upward. An empty `/tmp/.git` no longer turns every cwd under `/tmp` into a checkout, and a stray `.git` inside a real repository no longer hides the repository's HEAD and linked worktrees.
