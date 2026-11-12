---
section: Changed
audience: internal
---

- Build the Unit tests shard weights from the nightly test-history journal (`gen-test-shard-weights.mjs --journal`) and regenerate them, so recent tests are no longer unknown to the shard balance. (refs #5182)
