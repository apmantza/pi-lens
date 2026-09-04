---
section: Changed
---

- **CI production-dependency audit is bounded and retried** — `scripts/audit-prod-deps.mjs` wraps `npm audit --omit=dev --audit-level=high` with a per-attempt timeout and backoff; a real high/critical finding still fails the job, while a registry outage (2026-09-04: five-minute hangs then 400 from npm's retired quick audit endpoint) passes with a visible warning instead of redding every PR on an unchanged lockfile.
