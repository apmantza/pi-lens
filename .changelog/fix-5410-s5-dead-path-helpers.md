---
section: Removed
audience: internal
---

- Delete the sync `findCommand` from `clients/safe-spawn.ts` and the `isOnPath` wrapper from `clients/lsp/server.ts`. The LSP runtime gate calls `isCommandAvailableAsync` directly, so it asks the same PATH question as before. No observable change. (refs #5410)
