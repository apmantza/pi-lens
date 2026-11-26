---
section: Fixed
audience: user
area: blockers
---

- **A blocker carried without a verdict now says so, and is not repeated every write.** When a language server or runner gives no verdict on a write, the withheld and `Still unfixed` lines, the turn-end replay and the session read say the finding was not re-checked and name the `lens_diagnostics source=lsp` probe that settles it. An identical line is shown once per session until the blocker set changes or a source answers. (refs #5784)
