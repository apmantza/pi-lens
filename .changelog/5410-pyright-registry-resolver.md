---
section: Fixed
audience: user
area: runners
---

- **A pyright that fails its version check is now skipped, not run.** The runner used to fall back to the first `pyright` on PATH without checking it, so a broken install reported a failed run with a parse error. It now reads the one version check like every other runner and skips with the cause stated. It also finds a `pyright` in the project's own `node_modules/.bin`. On Windows, each project bin dir now supplies its own launcher extension (`.exe` in a venv, `.cmd` in `node_modules/.bin`) to every registry tool. (refs #5410)
