---
section: Changed
audience: internal
---

- **The metrics seam names each function by its owner, not its line.** `measureFile` returns an owner-qualified `key` for every function, built with the shared `findOwnerName` containment rule, and the binding-site namer moved from `function-facts.ts` into `clients/metrics/function-metrics.ts`, so the two name a function one way. (refs #5087)
