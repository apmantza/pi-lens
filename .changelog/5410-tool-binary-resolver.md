---
section: Fixed
audience: user
area: runners
---

- **Linters now find a project venv tool once pi trusts the project.** A
  linter that was skipped because pi had not yet trusted the project now
  checks again after trust is granted, so a project `.venv` ruff runs in the
  same session. Twelve linters (yamllint, markdownlint, stylelint and others)
  also stop re-running their version check on every edit when the tool is
  present but broken. (refs #5410)
