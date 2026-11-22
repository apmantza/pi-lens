---
section: Fixed
audience: user
area: lsp
---

- **An uncaught host error now runs exit cleanup for held language servers.** The LSP crash guard prints the stack and exits non-zero through Node's normal exit path, so pi RPC/print mode and the MCP host no longer leave a server behind. (refs #5744)
