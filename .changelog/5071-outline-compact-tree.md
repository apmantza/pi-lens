---
section: Changed
audience: user
---

- **`ast_grep_outline` returns a compact text tree instead of JSON** — one `77-81 export function name` line per symbol, range first like `module_report` compact; the read handles, byte offsets, node kinds and empty signatures are gone, so a file outline is about 5x to 10x smaller and a directory call now fits the delivery bound instead of arriving cut in the middle. Files are sorted by path before the 50-file cap, and a `... N more files not shown` line says what was left out. Read a listed range with `offset=start`, `limit=end-start+1` (#5071, refs #1449).
