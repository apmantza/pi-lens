---
section: Fixed
audience: user
area: lsp
---

- **A dead or cancelled language server no longer retires a carried code-action warning as clean.** A code-action request that died, was cancelled or came back malformed keeps the warning. A failed capability lookup, a defensive path no real lookup reaches today, now reports the file as unconfirmed. (refs #5258)
