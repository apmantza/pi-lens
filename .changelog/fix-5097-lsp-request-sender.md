---
section: Fixed
audience: user
area: lsp
---

- **Esc now returns an `lsp_navigation` call on a silent language server at once.** A request that times out or is aborted is cancelled on the wire and no longer keeps the server marked busy, so a wedged server is evicted when idle instead of piling up liveness pings. (refs #5097)
