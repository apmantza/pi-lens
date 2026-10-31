---
section: Changed
audience: user
---

- **`symbol_search` and `pilens_symbol_search` answer with one table, not a table plus the same hits as JSON (refs #5104).** The pi tool appended a compact `JSON.stringify` payload that repeated every hit, and the MCP mirror appended the same hits again as a fenced JSON block; neither carried anything the rows and footer cannot. `renderCompactSymbolSearch` in `clients/lens-engine.ts` now owns the text on both surfaces: a header, one row per hit — `  1. <path> <line> (score 0.82, 3 hit(s), fanIn 4)` — and a footer with index coverage, the MCP-only staleness note, and one next-step line naming the top-ranked hit (`module_report <path>` on pi, `pilens_module_report <path>` on MCP). Annotations print whenever the cached review graph supplies them, so `fanIn 0` ("no known importers") shows instead of vanishing. Measured on four `clients/` files, one query each, through `finalizeToolResultWithDelivery`: `bytes=3395` before, `bytes=1109` after. `details` keeps `{ available, query, count, coverage }`.
