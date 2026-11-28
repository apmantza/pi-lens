---
section: Fixed
audience: user
area: lsp
---

- **A symlinked file and its real path now share one read-warm and crash-count entry.** Reading one file through a link and through its real path no longer starts a second LSP warm-up or splits `/lens-health`'s pipeline crash count in two. (refs #4907)
