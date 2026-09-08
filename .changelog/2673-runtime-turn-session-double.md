---
section: Fixed
---

- **Turn-end session test doubles use the shared runner-error predicate (closes #2673)** — partial runner errors with `failed === 0` now exercise the same classification as production instead of requiring `passed === 0` in four local `formatResult` doubles.
