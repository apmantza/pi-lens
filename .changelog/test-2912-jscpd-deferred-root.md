---
section: Fixed
---

- **Drain deferred jscpd fixture cleanup (refs #2912)** — jscpd test teardown keeps the shared `pi-lens-jscpd-` owner stem registered across bounded macrotask drains, covering every jscpd output-root prefix in the suite.
