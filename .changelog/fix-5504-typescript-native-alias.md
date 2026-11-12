---
section: Fixed
audience: user
area: lsp
---

- **TypeScript 7 installed as `@typescript/native` now runs the native language server.** With `node_modules/typescript` at version 6 or older, pi-lens launches the alias's own `bin/tsc` with Node. An `effect-tsgo` that exits during startup now falls back to the native launch, so JavaScript and TypeScript files keep a language server. (refs #5504)
