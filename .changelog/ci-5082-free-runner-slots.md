---
section: Changed
audience: internal
---

- **CI frees runner slots, rebalances the Unit shards and keeps one npm cache**: the four `TLA+ models` shard jobs no longer start on a pull request that leaves `formal/` and its checker alone (the required `TLA+ models` aggregate still reports), the Unit shard weights are regenerated from five master runs (215 test files had no recorded duration), the Unit shards restore `~/.npm` once instead of twice, and `cache-prune.yml` prunes on every master push so the CodeQL overlay databases stay bounded (#5082).
