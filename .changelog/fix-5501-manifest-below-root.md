---
section: Fixed
audience: user
area: lsp
---

- **A member crate's `Cargo.toml` or a nested `go.mod` fixed outside pi now reaches the running server.** Both servers read it without a restart. A manifest fixed after a server started, and before pi's first look at a client root other than the session root, now reaches that server. The session root and the MCP working directory still miss it. (refs #5501)
