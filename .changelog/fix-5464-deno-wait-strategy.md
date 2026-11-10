---
section: Fixed
audience: user
area: lsp
---

- **A cold Deno server now gets seven seconds on diagnostics calls, not on edits.** The pull wait fell back to the 1.5 second default, so a first check on a slow machine was abandoned and read as no answer. Per-edit checks stay capped at 2.5 seconds and the MCP warm-up at 6 seconds. The budget is only a ceiling, so a fast Deno answer returns at once. (refs #5464)
