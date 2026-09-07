---
section: Fixed
---

- **Ledger fields no longer read `[object Object]`, and a rejected LSP push-wait no longer surfaces as an unhandled rejection (refs #2700)** — `normalizeForLedger` serialises plain objects and arrays instead of `String()`-ing them (a value with its own throwing `toString` still raises into the ledger's corrupted-input failsafe); the LSP push-wait settle marker attaches on both the resolve and the reject path. Found by the oxlint type-aware pass (`no-base-to-string`, `no-floating-promises`); the same pass's `preserve-caught-error` sites now carry `{ cause }`.
