---
section: Changed
audience: internal
---

- **The Unit tests shard weights come from the newest ten green master runs.** The old 15-run snapshot held 1,205 drifted values and priced 10 live test files at the median; the refresh from the shard reports of ten green `ci.yml` push runs prices all 1,882 live files. (refs #3753)
