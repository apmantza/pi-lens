---
section: Fixed
audience: user
---

- **Automatic-test checkout ownership no longer lets a deleted test hide a real identity failure (refs #3691)** — A deleted or renamed failed-first test no longer records `test-checkout-identity-unavailable`; it is retired as `retired-missing` as before, so twenty deletions can no longer fill the ledger's per-kind cap ahead of a real `EACCES`. Ownership walks use a separate `findNearestMarkerRootDetailed`, and `findNearestMarkerRoot` keeps its original `string | null` contract. A session started in a plain folder with no `.git` that holds several repositories, a submodule, or a nested linked worktree still gets no automatic tests for the files inside them, by design; run them explicitly.
