---
section: Fixed
audience: user
area: lsp
---

- **A member crate's `Cargo.toml` or a nested `go.mod` fixed outside pi now reaches the running server.** Both servers read it without a restart, and a manifest fixed after a server started but before pi first looked at its project root is no longer missed. (refs #5501)
