---
section: Changed
---

- **The pre-push hook runs the flake-shape ratchet on test changes, and keeps its governance suites when the selection is too broad (refs #3472)** — a push that touches `tests/` now runs `tests/clients/flake-shape-ratchet.test.ts`, which no changed module imports. A push whose matched tests pass the 25-file cap (a change to `clients/lsp/client.ts` alone matches 71) used to run nothing; it now runs the armed governance suites alone. A new governance test, `tests/config/strategy-marker-pair-coverage.test.ts`, fails when a language server carries two diagnostic strategy markers and no test drives both on that server.
