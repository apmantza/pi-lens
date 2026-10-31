---
section: Fixed
audience: internal
---

- `tests/clients/installer/managed-tool-refresh-strategies.test.ts` clears `GH_TOKEN`, `GITHUB_TOKEN`, `ZIZMOR_GITHUB_TOKEN` and `ZIZMOR_OFFLINE` for every case through `withEnv` and restores the caller's values afterwards, so a token exported in the environment no longer reds nine github cells. (#5073)
