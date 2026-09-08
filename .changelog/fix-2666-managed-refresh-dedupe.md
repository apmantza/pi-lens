---
section: Fixed
---

- **Managed npm refreshes deduplicate shared packages (closes #2666)** — one package update now covers every registered tool id that shares its package, preserving refresh budget slots for other packages.
