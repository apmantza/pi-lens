---
section: Fixed
audience: user
area: runners
---

- **Ruff autofix now uses the lint runner's resolved Ruff command.** Nested packages whose own `.venv` holds the only Ruff no longer get skipped when dispatch starts at a workspace root. (refs #5410)
