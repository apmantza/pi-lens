---
section: Fixed
audience: user
---

- **Expired session hand-offs now preserve activated tools** instead of dropping them when a successor is interrupted before startup (closes #4236). Test-only successor pending-window overrides are restricted to Vitest child processes.
