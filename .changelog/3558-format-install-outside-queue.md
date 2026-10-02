---
section: Fixed
audience: user
---

- **A formatter pi-lens is still installing no longer holds the agent's edits to that file back (closes #3558)** — pi-lens took its turn in pi's queue for a file before it looked up the formatter's command, and that lookup can install the formatter (prettier, biome, ruff, shfmt, ktlint, ktfmt, typstyle, taplo). With `--immediate-format`, or at the end of the agent's run when pi-lens formats the files it changed, the agent's `edit` or `write` of that file waited for the install, for up to two minutes. The formatter now takes its turn once its command is found, just before it reads the file. A formatter pi-lens stopped waiting for while it was still being installed takes a turn of its own when it reaches the file, and keeps it until it exits.
