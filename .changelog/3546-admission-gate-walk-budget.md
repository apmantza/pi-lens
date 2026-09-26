---
section: Fixed
---

- **`flake-shape-ratchet`'s admission-gate case no longer times out under load (refs #3546)** —
  the `ADMITTED_AFTER_BASELINE entries carry the header and
  wallClockBudgetInclude membership` case walked the whole `tests/**/*.test.ts`
  import graph, uncached, once per admitted `support/` entry — the same
  first-caller-absorbs-the-shared-cost shape #3514/PR #3542 fixed for
  `countsByDetector`. The file list and each file's import targets are now
  memoized and pre-warmed in a `beforeAll` under their own budget, decoupled
  from the case's existing 30s timeout. Detection semantics are unchanged.
