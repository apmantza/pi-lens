---
section: Added
audience: internal
---

- `scripts/analyze-pi-lens-logs.mjs` now reports a per-(tool, phase) and per-runner latency distribution (count, nearest-rank p50/p95/max, and each group's share of its family's in-window time) in both the text and `--json` outputs, so a ranking of performance work can be read from real sessions' `latency.log` instead of only from the synthetic hot-path sampler (refs #5263).
