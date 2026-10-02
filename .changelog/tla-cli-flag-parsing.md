---
section: Fixed
audience: internal
---

- Reject unknown or value-less flags in `scripts/check-tla-models.mjs` before any download or TLC spawn, and accept the `--flag=value` form alongside `--flag value`, so a typo can never silently run the full, unsharded model population.
