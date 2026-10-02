---
section: Fixed
audience: user
---

- When pi replaces a session inside the same process (for example, resuming a
  session from another directory), the ended session's project root no longer
  stays in, or comes back into, the instance registry. Before, a shutdown that
  met this process's own registry write left the old root behind; a
  registration still waiting for the lock, or an LSP server recorded just
  before the switch, re-created it after shutdown; and such a registration, or
  a subagent worktree's removal still queued, could point the heartbeat's
  repair at the old root so the live root was never re-registered. Peers in
  the old root then saw a live pi-lens there: the shared-checkout guard
  reported false positives and warm attach could pick this process. Registry
  writes queued before shutdown now drop themselves if they run after it, and
  a removal that cannot take the lock at shutdown is queued behind the holder
  instead of being skipped (closes #3498).
