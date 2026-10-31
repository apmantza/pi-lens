---
section: Changed
audience: user
---

- **`ast_grep_outline` returns a compact text tree instead of JSON** — one `77-81 export function name` line per symbol, range first like `module_report` compact, with project-relative file headers; the read handles, byte offsets, node kinds and empty signatures are gone, so a file outline is about 5x to 10x smaller. The measured default case, a 60-file directory outline, now fits the delivery bound instead of arriving cut in the middle; the default call is not promised to fit every directory, and `items: "all"` or `view: "expanded"` on a large directory still hit the cut, which keeps a visible marker. Files are sorted by project-relative path before the 50-file cap, and a `... N more files not shown` line says what was left out. Read a listed range with `offset=start`, `limit=end-start+1` (#5071, refs #1449).
