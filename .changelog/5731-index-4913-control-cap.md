---
section: Fixed
audience: internal
---

- The `--no-lens` control case in `tests/index-4913-cli-flag-timing.test.ts` no longer carries the process's one-time cold start inside its 5 s cap, so it stays well under the cap on a slow CI runner, and its stale timeout-headroom baseline row is gone. (refs #5731)
