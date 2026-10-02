---
section: Fixed
audience: user
---

- `pi-lens build-graph` now prints a degraded line naming how many files a
  tree-sitter wasm trap cost its symbols, and reports the process-wide wasm
  abort that disables tree-sitter until restart, instead of the clean success
  line. The build still exits 0 and the affected files are re-extracted on the
  next build or process (refs #3678).
