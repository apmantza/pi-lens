---
section: Fixed
audience: user
area: lsp
---

- **A language-server check that did not answer no longer reads as clean.** A failed capability lookup now reports the file as unconfirmed, and a code-action request that died, was cancelled or came back malformed keeps a carried warning instead of retiring it. (refs #5258)
