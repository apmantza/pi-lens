---
section: Changed
audience: internal
---

- `guard-bash` now admits the read-only `git stash list` and `git stash show` (every writing stash form and any spelling it cannot classify stays denied), and every worktree-remove refusal names the new `scripts/worktree-remove.mjs <path>`, which unlinks a `node_modules` symlink, refuses a real `node_modules` directory, then runs `git worktree remove` (#5111).
