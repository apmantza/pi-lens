---
section: Fixed
---

- **Durable-store lock no longer steals a lock that is still being created (closes #3475)** — `acquireBoundedPidFileLock`, the lock behind the dispositions and actionable-warning stores, read a lock file whose owner had created it but not yet written its pid as a dead owner, and deleted it. Two processes then both wrote the store, and one update was lost. A lock with no readable pid now counts as live until it is 5 s old.
