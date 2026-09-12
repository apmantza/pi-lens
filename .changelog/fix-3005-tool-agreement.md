---
section: Fixed
---

- **Require project tool agreement before autonomous writes (refs #3005)** — the autofix and formatter paths now use one agreement seam, accept lockfile-backed Node evidence, and decline when project evidence cannot establish agreement. Immediate formatting, deferred formatting, and autofix all pass through it.
