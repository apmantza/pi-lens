---
section: Fixed
audience: user
---

- **The LSP client's change path still sends a save it merged (closes #3545)** — when a saved write of a file was merged into a queued content change, either replaced by it or kept out behind it as an older read, no save notification was sent, so a server that only diagnoses on save would not re-check the file. The change now sends the save once its own content has reached the server, carrying the text the server asked for. This reverses the earlier rule that a change drops a save it inherits. Nothing in pi-lens sends a content change through this path today (its only entry point, `LSPService.updateFile`, has no caller), so no user saw this; the fix keeps the path correct for when it gains one.
