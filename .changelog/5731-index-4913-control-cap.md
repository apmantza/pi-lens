---
section: Fixed
audience: internal
---

- The `--no-lens` control case in `tests/index-4913-cli-flag-timing.test.ts` and the mark-only turn case in `tests/index-4698-mark-only-turn-gate.test.ts` no longer carry the process's one-time cold start inside their 5 s cap, so both stay well under it on a slow CI runner, and their stale timeout-headroom baseline rows are gone. (refs #5731)
