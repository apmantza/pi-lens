---
section: Fixed
audience: user
area: lsp
---

- **A cold Rust touch no longer reads clean while rust-analyzer is still loading.** The language server now says when it has finished loading, and the diagnostics read waits for that. A check that runs out of time is reported as timed out, and a workspace that failed to load (a broken manifest) is reported as unconfirmed, never as a clean file. (refs #5487)
