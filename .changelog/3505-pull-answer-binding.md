---
section: Fixed
audience: user
---

- **A workspace pull answer is cached only when it is tied to the content pi-lens sent (closes #3505)** — with `PI_LENS_LSP_WORKSPACE_PULL=1`, a pulled answer was fingerprinted from the file on disk after the server replied. A file edited while the server was answering was therefore recorded as matching the old answer, and the next `lens_diagnostics mode=full` served that stale verdict from cache. An answer is now tied to the content pi-lens last sent the server, and only for an open document at the version the server reports. Any other pulled answer is still shown but is not cached, and a cached entry it replaces is removed. As a result, the pull path now re-asks the server for files pi-lens has not opened on each sweep.
