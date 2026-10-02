---
section: Added
audience: internal
---

- **guard-bash refuses an unscoped `pkill`/`killall` (closes #3556)** — `pkill`/`killall` match machine-wide by default, so stopping your own TLC or vitest run could kill a concurrent session's run too (the 2026-09-26 #3506 incident this fixes). `kill <pid>` still stops your own recorded PID; `pkill -f` with a pattern that includes your worktree's absolute path still allows, but only when that path is itself a linked worktree — the shared main checkout's own path is a prefix of every worktree path, so a pattern scoped to it would still match every worktree's TLC, and now denies. `killall` is never scoped — it matches by process name only, with no way to narrow it to one worktree.
