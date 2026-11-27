---
section: Fixed
audience: user
area: blockers
---

- **A commit held by a neighbour file's cascade error now says what clears it.** `--lens-guard` used to tell the agent to "write the affected files again", and no write cleared the hold. The refusal now says to fix the named files, re-check them, and end the turn. A neighbour fixed outside pi and confirmed clean with `lens_diagnostics source=lsp` no longer keeps its old cascade error on every later turn. (refs #5790)
