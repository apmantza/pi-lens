---
section: Fixed
audience: user
area: host
---

- **A timed-out `pilens_analyze mode=fresh` worker is now ended with everything it started.** The worker is forked through `safeSpawnAsync`, so a timeout signals its whole process group and escalates to SIGKILL, and a worker that ignores SIGTERM no longer outlives the call. (refs #4907)
