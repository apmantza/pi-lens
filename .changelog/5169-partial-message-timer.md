---
section: Fixed
audience: user
---

- **Headless sessions exit after an LSP server stops mid-message.** Stop the vscode-jsonrpc partial-message timer from rearming after client disposal. Thanks to SlanyCukr for the analysis. (#5169)
