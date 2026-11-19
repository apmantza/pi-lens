---
section: Fixed
audience: internal
---

- **Test workers no longer inherit the shell's active Python environment.** An
  exported `VIRTUAL_ENV`, `CONDA_PREFIX` or `UV_PROJECT_ENVIRONMENT`, and the bin
  directory activation put on PATH, gave every test that environment's tools.
  A developer with a global venv active saw tests read its pyright and pytest.
