---
section: Fixed
audience: user
area: blockers
---

- **A blocker carried without a verdict now says so, and is not repeated every write.** When a language server or runner gives no verdict on a write, the withheld and `Still unfixed` lines, the turn-end replay and the session read say the finding was not re-checked and how it settles: a language server's blocker names the `lens_diagnostics source=lsp` probe, a runner's waits for a later write its check answers, and one whose re-check is still running says so. An identical line is shown once per session, counted only once it reaches the agent, until the blocker set changes or a source answers. The session read no longer prints an all-clear while the commit gate still holds a blocker. (refs #5784)
