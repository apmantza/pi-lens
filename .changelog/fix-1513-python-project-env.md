---
section: Fixed
---

- **Use project Python environments without shell activation (refs #1513)** — Pyright language-server and standalone-runner processes now use a detected `VIRTUAL_ENV`, `CONDA_PREFIX`, `.venv`, or `venv`. Project-local pyright, basedpyright, and ty binaries take precedence over managed fallbacks.
