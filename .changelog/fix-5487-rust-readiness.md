---
section: Fixed
audience: user
area: lsp
---

- **A cold Rust touch no longer reads clean while rust-analyzer is still loading.** The language server now says when it has finished loading, and the diagnostics read waits for that. If the wait runs out first, the result says the server is still loading. A workspace that failed to load (a broken manifest) is named with the server's message and a hint to fix the manifest. Neither case reads as a clean file. (refs #5487)
