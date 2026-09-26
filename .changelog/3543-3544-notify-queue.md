---
section: Fixed
---

- **The LSP notify queue reports only content it sent, and no longer loses a newer edit behind an older read (closes #3543, closes #3544)** — a file touch on a language server that had just died reported its content as delivered, so pi-lens marked the file as in sync and the drift check never re-sent it to the restarted server. A touch now counts as delivered only when its content reached the server, including when the server's pipe refuses the write. This reverses the #3501 decision that a dead server's write still counts as delivered: that decision protected the per-server debounce, but the drift record is kept per file. A rename whose re-open fails now says whether the server died or a close is still queued. Separately, when an older read of a file arrived while a newer edit without a read time was still queued, the queue discarded both and the server kept stale content; the newer edit is now sent.
