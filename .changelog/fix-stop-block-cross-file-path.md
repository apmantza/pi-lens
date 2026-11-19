---
section: Fixed
audience: user
area: blockers
---

- **A STOP block now names the file a cross-file blocker belongs to.** The mypy
  runner reports errors in the modules an edit imports, and those rows used to read as
  lines of the edited file, with that file's line shown as their snippet. An
  agent then marked them against the wrong file, where the mark never applied.
