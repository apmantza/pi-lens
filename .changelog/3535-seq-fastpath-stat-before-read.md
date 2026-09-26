---
section: Fixed
---

- The review graph's seq fast path now records each changed file's
  `size:mtimeMs` before it reads the file, not after. Before, a write that
  landed while the fast path was reading (an IDE save, a formatter) was
  signed as already read, so every later build without a seq hint (MCP, the
  CLI, `project_report`) served the old graph as current, in the same process
  and from `review-graph.json.gz`, until the file changed again. The model is
  in `formal/review-graph-signatures/` (refs #3535).
