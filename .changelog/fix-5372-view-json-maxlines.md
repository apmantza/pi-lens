---
section: Fixed
audience: user
area: tools
---

- **Tool view and maxLines parameters now answer the same on pi and MCP.** `view:"json"` returns JSON on `module_report`, `project_report` accepts the known JSON preset names (`json`, `summary-json`, `full-json`) as its JSON hatch, and `read_enclosing` clamps `maxLines` to a floored minimum of 1 in the engine, so pi and MCP report the same number.
  (refs #5372)
