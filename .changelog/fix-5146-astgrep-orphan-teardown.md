---
section: Fixed
audience: internal
---

- The #3748 advisory witness ends the sessions each case starts, so the `ast-grep lsp` child its adopted-project `tool_result` spawns no longer outlives the test worker. A per-case census reds any such child the worker still owns (refs #5146).
