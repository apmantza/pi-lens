---
section: Fixed
---

- **Ledger fields no longer read `[object Object]`, and two promise chains no longer reject unhandled (refs #2700)** — `normalizeForLedger` serialises plain objects and arrays instead of `String()`-ing them; the LSP push-wait settle marker and the ast-grep load task attach their derived promises on both paths. Found by the oxlint type-aware pass (`no-base-to-string`, `no-floating-promises`); the same pass's `preserve-caught-error` sites now carry `{ cause }`.
