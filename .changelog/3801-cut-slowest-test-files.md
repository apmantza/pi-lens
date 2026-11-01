---
section: Changed
audience: internal
---

- The slowest test files run faster: the route-matrix, MCP smoke, pre-push, lane-check and head-move files are split by describe over shared `tests/support` kits, the 4320, 4322 and s7 diagnostics cases wait less, the stryker-diff case spends its budget with a clock offset instead of sleeping, and the guard-bash corpus case spawns its hooks four at a time. No test was dropped; the shard weights for split files are apportioned from local ratios until CI regenerates them. (refs #3801)
