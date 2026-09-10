---
section: Fixed
---

- **Make pi RPC `session_start` idempotent per reason and session file (closes #2890)** — repeated replacement events no longer repeat tool restoration or session-state resets, while a different session file starts a new mutation pass.
