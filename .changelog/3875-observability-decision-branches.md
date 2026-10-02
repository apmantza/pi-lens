---
section: Changed
audience: internal
---

- The PR body check now refuses the no-record sentence when a diff adds a decision branch on a session, lifecycle or delivery seam, and accepts a `none: <reason>` that names each flagged file as the way to say a branch has no record (#3875).
