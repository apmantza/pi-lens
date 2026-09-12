---
section: Fixed
---

- **Require project tool agreement before autonomous writes (refs #3005)** — the autofix and formatter paths use one cached agreement seam, accept lockfile-backed Node evidence, and decline with typed reasons when evidence cannot establish agreement. Immediate formatting, deferred formatting, and autofix all pass through it.
