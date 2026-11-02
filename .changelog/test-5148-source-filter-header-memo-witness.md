---
section: Changed
audience: internal
---

- The generated-header memo test in `source-filter-async.test.ts` now proves the memo through the verdict a re-read would flip, not a cold/warm wall-clock ratio that a loaded shard could invert (refs #5148, #4909).
