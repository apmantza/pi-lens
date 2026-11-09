---
section: Fixed
audience: user
area: runners
---

- **A linter that hangs now costs one timeout per session, not one per edit.**
  Any linter whose run times out is skipped for the rest of the session
  before it spawns or checks its version again, and the skip is reported
  once. A slow linter that runs after the edit no longer starts a second copy
  while one is still running: edits made meanwhile get one rerun per file
  once the first run ends. (refs #5413)
