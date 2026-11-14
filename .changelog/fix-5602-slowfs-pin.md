---
section: Fixed
audience: internal
---

- Pin the slow-filesystem kill switch (`PI_LENS_ALLOW_SLOW_FS_SCAN=1`) for every pi-session test case, so its notification assertions no longer depend on the runner's disk latency. A forced-slow case guards the pin, and the restore runs in `afterAll`. (refs #5602)
