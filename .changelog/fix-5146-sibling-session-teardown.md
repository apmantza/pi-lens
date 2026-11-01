---
section: Fixed
audience: internal
---

- The test files that start sessions on the pi double now end them through one shared `endMockSessions` teardown, so no `ast-grep lsp` child outlives its file and reaches the orphan sweep of a later file. The double reports every session its handlers saw, and a case that ends with one still open reds, whichever route started it (refs #5146).
