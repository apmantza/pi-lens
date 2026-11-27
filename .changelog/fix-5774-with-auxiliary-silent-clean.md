---
section: Fixed
audience: user
area: lsp
---

- **A clean markdown or Lua edit beside an auxiliary is now confirmed clean.** Before, the per-edit check waited its full budget and then reported the file as not fully checked, because marksman and lua-language-server publish nothing for a clean file. The edit is now confirmed when the server was already running, answers a liveness probe, and never pushed a finding it has not withdrawn. TypeScript keeps its own check. (refs #5774)
