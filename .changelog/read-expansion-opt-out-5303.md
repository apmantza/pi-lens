---
section: Added
audience: user
area: config
---

- **Read widening can now be turned off without losing the read-before-edit guard.** Pass `--no-read-expansion` or set the global `readGuard.expandReads=false` to keep the requested read ranges while the guard stays active. Read widening stays on by default. (refs #5303)
