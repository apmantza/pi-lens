---
section: Fixed
audience: user
---

- **A turn worklist owned by a process pi-lens may not signal is no longer handed to the next writer (refs #4907)** — the turn-state owner check read a permission error from `process.kill(pid, 0)` as "owner gone", so a live foreign worklist was reported `available`. It now shares the one pid-liveness check (`clients/pid-liveness.ts`) with the instance registry, the install lock, the bounded pid-file lock and the generation lock, which read that error as alive.
