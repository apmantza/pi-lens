---
section: Fixed
---

- `analyzeFile`'s MCP result now consumes the exact latency report carried by
  `DispatchResult`, so a 100-entry ring and concurrent same-path dispatches
  cannot cause cross-call attribution or a foreign fallback (refs #3642,
  refs #3643).
