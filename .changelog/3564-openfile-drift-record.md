---
section: Fixed
audience: user
---

- **Opening a file on a dead language server no longer marks it as in sync (closes #3564)** — the open path used by actionable warnings and the diagnostic-freshness checks recorded the file's content as held by the server even when nothing was sent, for example because the server had just died. The drift check then saw the file as in sync and never sent it to the restarted server. The record is now written only when the content reached the server, as the file-touch path already did after #3543.
