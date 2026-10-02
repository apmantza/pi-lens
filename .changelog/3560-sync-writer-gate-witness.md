---
section: Fixed
audience: internal
---

- **A test now fails if the synchronous snapshot writer stops dropping superseded saves (closes #3560)** — the main-thread snapshot writer (used with no worker, after a worker death, after a failed promotion rename, and at process exit) skips a save that a newer one superseded. Forcing that check to pass left both snapshot suites green. It is the only guard when another process held the cache lock while the newer save was admitted, so the newer seq never reached the meta file. The new test builds that state and fails with the check forced to pass, because the older snapshot's body then lands.
