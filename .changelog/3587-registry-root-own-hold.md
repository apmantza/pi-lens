---
section: Fixed
audience: user
---

- A declined secondary worktree's root no longer stays in the instance
  registry for the rest of a live session. Before, the removal could meet
  this process's own registry write (its heartbeat, or a registration under
  the lock); the removal ran off a sync-only lock wait with no retry, so it
  gave up after 500ms and the secondary's root leaked until the host
  process exited. The removal now falls back to the same queued, lock-lease
  wait `deregisterInstance` already uses at shutdown (closes #3587).
