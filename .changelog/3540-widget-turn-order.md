---
section: Fixed
audience: user
---

- **A file's first edit in a new turn replaces its diagnostics from the previous turn (closes #3540)** — pi-lens numbers the writes of each turn from 1 again, but the diagnostics widget and the check that retires a blocker once `lsp_diagnostics` confirms a file clean compared those numbers across turns. A file edited as the third write of one turn and the first write of the next kept the older turn's result in the widget, and a confirmed-clean check in the next turn could not retire the older turn's blocker. Both now order a write by its turn first, as the blocker record already did. That turn keeps counting across `/new` and `/reload`, so a previous session's later turns never outrank the next session's edits in the widget, which `/reload` keeps.
