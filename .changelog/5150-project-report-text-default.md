---
section: Changed
audience: user
---

- **`project_report` returns a line-oriented text report by default (refs #5150)** — the tool and its MCP mirror `pilens_project_report` now answer with the compact text cell on every path, warm or cold, so the first tool an agent calls no longer spends a full JSON document on an orientation read. Pass `view: "json"` to get the same engine document as before, byte-for-byte; any other value falls through to text. The MCP warm path also stops appending a fenced JSON copy and reports staleness in its own trailing block.
