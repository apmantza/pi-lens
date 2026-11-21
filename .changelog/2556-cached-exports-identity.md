---
section: Fixed
audience: user
area: blockers
---

- **A file reached through a symlink no longer blocks its own export.** The duplicate-export STOP and the cached-export refresh compared two spellings of one file as two files, so an edit through the real path left a removed export cached and the next write that declared it was refused. (refs #2556)
