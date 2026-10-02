---
section: Fixed
audience: user
---

- **The LSP client's change path marks a re-opened file open again (closes #3549)** — when a content change reached a file the language server had closed, the client re-opened it with a fallback open but still treated it as closed, so every later diagnostics report for the file was discarded. The fallback open now clears the closed mark, as the main open does. Nothing in pi-lens sends a content change through this path today (its only entry point, `LSPService.updateFile`, has no caller), so no user saw this; the fix keeps the path correct for when it gains one.
