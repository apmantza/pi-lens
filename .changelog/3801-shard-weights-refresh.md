---
section: Changed
audience: internal
---

- **The Unit tests shard weights come from fifteen master runs.** The old snapshot held one regressed file at 302 s after its fix. The slowest shard ran 62 s p50 over the mean (measured). The refresh models 16 s over the mean with no run noise, and about 32 s p50 with run noise (modelled). The shard count stays at five. The model alone gives the 3, 4 and 6 comparisons; no run measured them. (refs #3801)
