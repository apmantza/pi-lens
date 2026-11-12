---
section: Fixed
audience: user
area: runners
---

- **Ruff autofix now runs the same ruff the lint ran.** In a nested package whose own `.venv` holds the only ruff, autofix read "ruff unavailable" (or ran a PATH or managed ruff), and one client kept the first package's binary for every later package; autofix now resolves the binary at the cwd the lint runner uses. (refs #5410)
