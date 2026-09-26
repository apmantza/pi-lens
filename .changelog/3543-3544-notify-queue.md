---
section: Fixed
---

- **The LSP notify queue reports only content it sent, and no longer loses a newer edit behind an older read (closes #3543, closes #3544)** — a file touch on a language server that had just died reported its content as delivered, so pi-lens recorded the file as in sync and skipped re-sending the same content once the server was back. A touch now counts as delivered only when its content reached the server, including when the server's pipe refuses the write. Separately, when an older read of a file arrived while a newer edit without a read time was still queued, the queue discarded both and the server kept stale content; the newer edit is now sent.
