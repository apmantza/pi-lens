---
section: Fixed
audience: user
---

- **A diagnostics pass no longer rewrites your file under a project fix setting**: `ruff check` now runs with `--no-fix --no-fix-only` (a project `fix = true` or `fix-only = true` used to delete unused imports on save, even with pi-lens format and autofix off) and `golangci-lint run` with `--fix=false` (`issues.fix: true`); `markdownlint-cli2` runs with a preload that makes its fix write a no-op (a `"fix": true` directory config rewrote the file); the autofix stage still fixes, and stylelint was probed and does not write (#5119).
