---
section: Fixed
audience: user
---

- Key the tree-sitter rule batch compiles per query source and stop caching a batch built across a wasm trap: a rule whose compile always traps now spends one trap-budget unit however often its batch is rebuilt (LRU eviction, a rule edit) instead of aborting the runtime on the fourth, and one transient compile trap no longer leaves the rule skipped, or the batch on the slower per-rule path, until restart (closes #3707).
