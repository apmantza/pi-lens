---
section: Added
audience: internal
---

- `scripts/analyze-pi-lens-logs.mjs` now reports a per-(tool, phase) and per-runner latency distribution in both the text and `--json` outputs. Percentiles are the clamped floor-rank index `clamp(floor(p * n), 0, n - 1)` over the ascending sample, so every reported number is an observed row and, for any group of 20 rows or fewer, p95 equals max. Each group carries count, p50, p95, max and its share of the summed recorded phase spans (nested spans overlap); age rows (the shared span-or-age rule of #5379), parent `total` rows and runner skip or pending rows stay out of the samples and are counted, and a section that truncates says "showing N of M groups". `--limit` below 1 is refused at parse. A ranking of performance work can therefore be read from real sessions' `latency.log` instead of only from the synthetic hot-path sampler (refs #5263).
