---
section: Fixed
audience: user
---

- **A subagent started during a reload no longer demotes the main session (closes #3662)** — after `/reload`, `/new`, resume or fork, pi-lens briefly has no primary session. A subagent that started in that window used to register as the primary. The reloaded session was then treated as a secondary and skipped its full session start. A `startup` start in that window is now declined as a concurrent secondary, so the real successor still runs the full start. If no successor starts within 60 seconds, starts are classified as before and the ledger records `session-successor-pending`.
