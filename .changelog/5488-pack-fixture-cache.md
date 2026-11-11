---
section: Fixed
audience: internal
---

- Exclude the worktree's derived Vitest cache from isolated package-test copies so retry checks do not copy accumulated test output (refs #4561).
