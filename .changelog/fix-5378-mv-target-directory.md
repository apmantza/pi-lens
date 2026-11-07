---
section: Fixed
audience: user
area: tools
---

- **Every file a `mv -t` move renames stays tracked.** `mv -t DIR a b` and `mv --target-directory=DIR a b`, and the same after `git mv`, reported only the first moved file, so a later edit of the others was refused as a file never read and the paths they moved to were not recorded as written; both argument orders now report every source and every destination. (refs #5378)
