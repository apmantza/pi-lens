---
section: Fixed
audience: user
area: blockers
---

- **A file reached through a symlink no longer blocks its own export.** The duplicate-export STOP, the cached-export refresh and the deferred runner blocker each compared two spellings of one file as two files, so an edit through the real path left a removed export cached, the next write that declared it was refused, and a deferred blocker lost its line text. All three now compare by path identity. (refs #2556)
