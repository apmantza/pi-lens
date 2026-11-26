---
section: Fixed
audience: user
area: blockers
---

- **A second session in one workspace no longer takes the first session's startup guidance.** The guidance record now names the session that wrote it, so a concurrent subagent's first request leaves it in place and the writing session still receives it. (refs #5792)
