---
section: Fixed
audience: user
area: lsp
---

- **A cold Rust touch no longer reads clean while rust-analyzer is still loading.** The language server now says when it has finished loading, and the diagnostics read waits for that. A touch that runs out of time reports that the server was still loading instead of a clean file. (refs #5487)
