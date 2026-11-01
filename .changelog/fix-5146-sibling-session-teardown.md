---
section: Fixed
audience: internal
---

- The test files that start sessions on the pi double now end them through one shared `endMockSessions` teardown, so no `ast-grep lsp` child outlives its file and reaches the orphan sweep of a later file. A governance test refuses a session-starting importer that ends none (refs #5146).
