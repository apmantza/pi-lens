---
section: Fixed
audience: user
---

- **A blocker withheld from a script-written file reaches the agent even when the check outlasts 10 seconds (refs #5108)** — when a file the agent wrote through a script was checked by a slow first-run analyzer (a cold Pyright, say), pi-lens stopped waiting after 10 seconds and the finding it had withheld reached nobody. The check now tells the agent at its next turn that it finished late, which file holds blockers, and where to list them, once per file.
