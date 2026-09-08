---
section: Fixed
---

- **Fail the oxlint advisory tier when type-aware support is unavailable (refs #2709)** — `lint:js:advisory` now checks that `oxlint-tsgolint` resolves, exposes its binary, and satisfies oxlint's declared peer range before running.
