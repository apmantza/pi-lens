---
section: Fixed
---

- `analyzeFile`'s MCP result no longer drops the latency report once the
  100-entry ring is at capacity. The report is matched by stable object
  identity across the before/after ring snapshots, with `pathsEqual` used
  only to disambiguate multiple concurrent appends; foreign reports are never
  used as a fallback (refs #3642, refs #3643).
