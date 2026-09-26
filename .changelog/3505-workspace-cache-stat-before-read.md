---
section: Fixed
---

- **An edit that lands during a `lens_diagnostics mode=full` sweep no longer caches a stale result for the file (refs #3505)** — the sweep recorded each file's timestamp and size after reading it, so an edit landing in between was recorded as the state the answer described, and later sweeps served the old verdict from cache, across sessions for a clean one. A file whose import was edited while it was being checked was likewise treated as fresh. The sweep, and the `lsp_diagnostics` batch scan, now record both before reading the file, so the next sweep checks it again. Answers from a project-wide workspace pull (`PI_LENS_LSP_WORKSPACE_PULL=1`) are not yet tied to the bytes the server read, and still cache the same way for the file itself.
