---
section: Fixed
---

- **Turn-end test failures now reach the next model context without a terminal entry (closes #2733)** — settled failures keep their provenance and advisory framing, survive session reset until delivery, then deliver once through the next context build. Rehydration matches the stable session id only, so `--session` quit-and-resume works across activation owners while in-process activation isolation stays in the pending map. Pull diagnostics and MCP turn-end handling remain unchanged.
