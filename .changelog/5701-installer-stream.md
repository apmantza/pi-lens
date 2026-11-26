---
section: Fixed
audience: user
area: install
---

- **The Opengrep rule pack now streams to disk, and release metadata is size-capped.** The pack download no longer holds its whole body in memory, a pack download that outlasts 60 seconds is cut off with its partial file removed, and a GitHub release answer past 2 MiB is refused. (refs #5701)
