---
section: Changed
audience: internal
---

- Five hand-rolled "race a promise against a timer" waits (the runner budget in `runRunner`, `getOpenDocumentSymbols`, the quiet-window heartbeat sample, the session-start sequence read and the analyze CLI's stdin read) now call `withBudget`, and the `hand-rolled-race` scan reads `Promise.race<T>(`, aliased, destructured and computed references instead of only the bare call, which registers the client-wait race in `clients/lsp/index.ts` that it could not see (refs #4907).
