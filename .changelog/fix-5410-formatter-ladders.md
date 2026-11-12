---
section: Fixed
audience: user
area: runners
---

- **Formatters now find their tool the way the linters do.** A formatter no longer runs a parent directory's Python virtualenv (a monorepo whose only venv sits at the repo root must put black on PATH), and a broken copy on PATH no longer hides a working managed install of shfmt, taplo, ktlint, ktfmt, typstyle, black, google-java-format or cljfmt. The order is the project's own tool, then PATH, then the managed copy: a working PATH formatter still wins, so a team that pins its formatter version is not overridden. A formatter that is installed but fails its version check is reported as failed, with its error output, instead of "not found", and a broken sqlfluff is no longer run and read as an unchanged file. (refs #5410)
