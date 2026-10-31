---
section: Fixed
audience: user
---

- **A diagnostics pass no longer rewrites your file under a project fix setting**: `ruff check` now runs with `--no-fix --no-fix-only` (a project `fix = true` or `fix-only = true` used to delete unused imports on save, even with pi-lens format and autofix off) and `golangci-lint run` with `--fix=false` (`issues.fix: true`) (#5119).
