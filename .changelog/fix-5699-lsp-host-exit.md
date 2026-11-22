---
section: Fixed
audience: user
area: lsp
---

- **Language servers now end with the pi or MCP process that started them.** On Linux and macOS, a server that ignored stdin EOF and SIGTERM outlived a pi quit, an MCP client disconnect, a SIGTERM to the MCP host and every `fresh` analysis worker. pi-lens now sends each held server's process group SIGKILL when its host exits. A host killed before that keeps its `instances.json` row, and the next pi or MCP start reaps the server. A server's child that ignores SIGTERM after the server exits is killed too, and `fresh` analysis now reads `lsp.json`. (refs #5699)
