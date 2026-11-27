---
section: Fixed
audience: internal
---

- `tests/index-wiring.test.ts` no longer reads an earlier case's global-bin-dir prime in the #2515 S3 `/lens-perf` case's exact degradation list: its root `afterEach` takes one macrotask turn so the `setImmediate`-scheduled prime starts, then joins the registered background drains, so shuffle seeds 202 and 8888 stay green. (refs #5794)
