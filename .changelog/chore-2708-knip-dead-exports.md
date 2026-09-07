---
section: Changed
---

- **Internal: 295 unused exports, 235 unused exported types and 4 duplicate exports removed, with the 85 declarations that became dead (refs #2708)** — no user-facing behaviour changes; the public entry points, the MCP server and every script keep their exports. Found by knip with tests counted as entry points, so nothing a test imports was touched.
