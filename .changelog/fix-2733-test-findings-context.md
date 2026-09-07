---
section: Fixed
---

- **Turn-end test failures now reach the next model context without a terminal entry (closes #2733)** — settled failures keep their provenance and advisory framing, then deliver once through the next context build; pull diagnostics and MCP turn-end handling remain unchanged.
