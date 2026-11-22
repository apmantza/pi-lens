---
section: Fixed
audience: user
area: lsp
---

- **Language servers now end with the pi or MCP process that started them.** A server that ignored stdin EOF and SIGTERM outlived a pi quit, an MCP client disconnect, a SIGTERM to the MCP host and every `fresh` analysis worker. pi-lens now sends each held server's process group SIGKILL when its host exits. A host killed before that keeps its `instances.json` row, and the next pi or MCP start reaps the server. (refs #5699)
