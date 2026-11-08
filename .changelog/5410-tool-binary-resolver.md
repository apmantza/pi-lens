---
section: Fixed
audience: user
area: runners
---

- **Linters now find a project venv tool once pi trusts the project.** A
  linter that was skipped because pi had not yet trusted the project now
  checks again after trust is granted, so a project `.venv` ruff runs in the
  same session. In a trusted project, the project's own `.venv` or
  `node_modules/.bin` copy of a linter now runs ahead of pi-lens's managed
  copy and the one on PATH; a project copy that cannot start falls back to
  them. Twelve linters (yamllint, markdownlint, stylelint and others) also
  stop re-running their version check on every edit when the tool is present
  but broken. (refs #5410)
