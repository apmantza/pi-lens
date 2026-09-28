---
section: Fixed
---

- `analyzeFile`'s MCP result no longer drops the latency report once the
  100-entry ring is at capacity. The report was matched by a before/after
  length delta, which the ring's push+shift keeps unchanged (100 -> 100) once
  full, so `result.latency` and `result.fileKind` silently came back
  `undefined` for any file analyzed after 100 dispatches had run. The report
  is now matched by path against the full current ring instead (closes
  #3642).
