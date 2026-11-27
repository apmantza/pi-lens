---
section: Added
audience: user
area: config
---

- **The caps on retained injections are now config keys, and `0` removes a cap.** `contextInjection.retainMaxEntries`, `retainMaxBytes` and `retainMaxSessions` replace the fixed 64 entries, 256 KiB and 32 sessions, so a long session no longer loses cache stability once it passes them. (refs #5770)
