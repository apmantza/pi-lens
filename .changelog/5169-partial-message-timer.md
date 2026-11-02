---
section: Fixed
audience: user
---

- **Headless sessions exit after an LSP server stops mid-message.** Disable the unused vscode-jsonrpc partial-message timeout before listening so no pending tick delays teardown. Thanks to SlanyCukr for the analysis. (#5169)
