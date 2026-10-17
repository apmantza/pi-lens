---
section: Fixed
audience: internal
---

- `waitFor` and `suspendAt` in `tests/clients/interleaving-kit.ts` multiply their wall budget, the default and a caller's `timeoutMs` alike, by `PI_LENS_TEST_TIMEOUT_SCALE`, and an exhausted wait names its caller, the elapsed time and both budgets (#4437). The `Run targeted tests` step of `Targeted tests (advisory)` now sets the knob to 3, which it lacked when run 38618401454 failed a 3000 ms wait.
