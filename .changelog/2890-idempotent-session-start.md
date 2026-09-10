---
section: Fixed
---

- **Make pi RPC `session_start` idempotent per reason and session ID, with a session-file fallback (refs #2890)** — repeated replacement events no longer repeat tool restoration or session-state resets, while a different session identity starts a new mutation pass.
