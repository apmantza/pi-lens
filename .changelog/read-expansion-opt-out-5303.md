---
section: Added
audience: user
---

- **Read widening opt-out (closes #5303)**: Use `--no-read-expansion` or global `readGuard.expandReads=false` to keep requested read ranges while the read-before-edit guard stays active. Read widening remains on by default.
