---
section: Added
audience: internal
---

- **A `symbol_search` query-metrics instrument measures the D8 acceptance signal over recorded pi sessions (refs #5138)** — `scripts/symbol-search-query-metrics.mjs` reports `emptyRate`, `listedReadRate`, `repeatReadRate`, `drilldownRate` and `unscannableRate` per time window, so each PR in the #5138 sequence can quote a before/after from the append-only session JSONL instead of "metric absent". No runtime path changes; no CI gate.
