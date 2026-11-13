---
section: Changed
audience: internal
---

- **The Unit tests shard weights come from fifteen master runs.** The old snapshot held one regressed file at 302 s after its fix, so the slowest shard ran 62 s over the mean. The refresh models 16 s over the mean, and the shard count stays at five after a 3, 4, 5, 6 comparison on measured durations. (refs #3801)
