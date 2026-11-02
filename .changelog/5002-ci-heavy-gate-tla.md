---
section: Fixed
audience: internal
---

- PR-time CodeQL runs again on pull requests that leave `formal/` alone. `heavy-gate` reached the skipped `tla-shards` job through `tla-models`, so implicit `success()` skipped the gate and CodeQL. The gate now reads `TLA+ models` from check-runs and needs `Unit tests Windows`. The ten required contexts live in one list, `BRANCH_PROTECTION_CONTEXTS`, and the stale docs and pins that said eight now match. (refs #5002)
