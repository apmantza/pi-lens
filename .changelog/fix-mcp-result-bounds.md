---
section: Fixed
---

- **Bound MCP tool results through the shared pi result seam (refs #2799, #2800)** — oversized results retain head and tail context, report omitted characters, and preserve the complete payload in the session log; the roster budget rejects duplicate tool names; results above the documented 8 MiB input budget keep a bounded head, an explicit incomplete marker and the tail in the session log, with one `mcp-complete-result-budget-exceeded` degradation per session.
