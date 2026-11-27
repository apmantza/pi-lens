---
section: Changed
audience: internal
---

- The retention sweep's pid-scoped socket gate reads its owner through `realIsPidAlive` instead of its own `process.kill(pid, 0)` copy, so one liveness reading serves every consumer. (refs #4907)
