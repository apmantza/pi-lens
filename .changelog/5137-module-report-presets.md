---
section: Changed
audience: user
---

- **`module_report` view is now a preset** — `view` names projection ×
  format: `summary-text` (default, metrics off, text), `summary-json`,
  `full-text`, `full-json` (every field, JSON). Applies to `module_report`
  and `pilens_module_report`. The text cell is lossless against its JSON
  payload (metrics as `cx:`/`fo:` suffixes, flags per bracket, `used-by:`
  lines, `IMPORTS:` / `CALL GRAPH:` / `BLAST RADIUS:` blocks, `PROVENANCE:`
  footer); the stale `summary` / `default` / `compact` names fall through to
  the default, and a `maxRefsPerSymbol` argument promotes the projection to
  `full`. MCP no longer wraps the payload in a fenced JSON block.
  (refs #5137)
