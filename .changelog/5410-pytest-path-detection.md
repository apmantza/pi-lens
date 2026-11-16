---
section: Fixed
audience: user
area: runners
---

- **Projects without a Python environment now run tests with the pytest on PATH.** Before, pi-lens ran a bare `python -m pytest`, which failed where `python` is missing or lacks pytest. A project with its own environment still runs that interpreter's `-m pytest`. (refs #5410)
