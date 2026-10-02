---
section: Added
audience: internal
---

- Add `scripts/pr-worktree.mjs open` / `close` for review and trailing-commit worktrees, which unlinks only a symlinked `node_modules`, refuses a real directory, the main checkout, a tree outside the worktrees root or a dirty tree, then removes the worktree and its local branch unless that branch holds commits no remote has (closes #3723).
