---
section: Fixed
audience: user
area: lsp
---

- **A manifest fixed before pi's first look at a project now reaches its running server.** An MCP hover that started rust-analyzer, then a fixed `Cargo.toml`, used to leave `pilens_diagnostics` reading `workspace failed to load`. The session root and the MCP working directory now forward a manifest fixed after the server started, and still restart no server for an install on that first look. (refs #5501)
