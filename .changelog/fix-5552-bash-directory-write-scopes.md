---
section: Fixed
audience: user
area: host
---

- **Bash `rsync -a`, `tar x` and `mv` into a directory are now seen.** When the file keeps an old modification time, a move or copy into a directory names `src/a.ts`, and an `rsync` into a tree or a `tar x` is credited by content in the directory it fills, so the changed file reaches dispatch, the change log and the commit gate like a `cp` does. (refs #5552)
