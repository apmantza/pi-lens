---
section: Fixed
audience: user
area: lsp
---

- **A fixed `Cargo.toml` or `go.mod` now reaches the running language server.** Before, rust-analyzer kept reporting that its workspace failed to load, and gopls kept an old `go` version's findings, until the server restarted. The manifest at the project root is sent as a watched-files event when it changes outside the editor session. (refs #5501)
