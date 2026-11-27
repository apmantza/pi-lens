---
section: Fixed
audience: user
area: blockers
---

- **A cascade note that reports no error no longer holds a commit refused.** When a language server stayed silent through the turn end, the impact cascade note it left made `--lens-guard` refuse `git commit` after every file was fixed and settled, until the next turn end. The note still reaches the agent. (refs #5790)
