---
section: Changed
audience: internal
---

- **The Unit tests shard weights come from the five newest journal days.** The old 15-run snapshot held 1,205 drifted values and priced 10 live test files at the median; the refresh from `history/test-daily.ndjson` (2026-11-10 to 2026-11-14) prices all 1,880 live files. (refs #3753)
