---
section: Fixed
audience: user
area: runners
---

- **A file whose checks were all skipped now says why it was not checked.** The write notice names each runner's cause (`spellcheck: not installed`, `vale: not configured`, a managed install turned off by `PI_LENS_DISABLE_TOOL_INSTALL=1`, a project policy that prefers another tool) instead of one sentence for a missing tool, a timeout and a failure alike. Nothing that was unchecked reads clean. (refs #5258)
