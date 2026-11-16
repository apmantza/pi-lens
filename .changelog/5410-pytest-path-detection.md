---
section: Fixed
audience: user
area: runners
---

- **A pytest found only on PATH now runs instead of failing to import.** With no pytest config, pi-lens ran the project interpreter's `-m pytest` even when only a pipx-style pytest was installed, and the run failed with "No module named pytest". It now runs that pytest unless the project environment installs its own. (refs #5410)
