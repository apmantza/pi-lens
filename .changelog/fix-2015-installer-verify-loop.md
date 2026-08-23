---
section: Fixed
---

- **Installer verify loop broken at the root (closes #2015)** — `verifyToolBinary` now spawns through `safeSpawnAsync` (tree-kill on timeout, typed kill-reason) instead of raw spawn whose SIGTERM orphaned grandchild node processes on Windows `.cmd` shims. A killed/inconclusive prober no longer counts as a verdict: the freshly installed binary is KEPT for cheap re-probe instead of deleted, ending the install/verify/reinstall churn (23 SIGTERMs and 4 cleanups observed in one day).
