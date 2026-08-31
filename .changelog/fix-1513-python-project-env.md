---
section: Fixed
---

- **Use project Python environments without shell activation (closes #2407, refs #1513)** — Python language servers, standalone Pyright, and pytest now use a detected `VIRTUAL_ENV`, `CONDA_PREFIX`, `.venv`, or `venv`. Project-local pyright, basedpyright, and ty binaries take precedence over managed fallbacks, while pytest runs through the project interpreter.
