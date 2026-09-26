---
section: Fixed
---

- **Renaming a file no longer leaves the old path open on the language server, or sends it an edit after closing it (closes #3477)** — the rename's close was sent beside the queue that orders each file's open and change messages. An edit still being written could reach the server after the close, an edit queued before the rename could re-open the renamed-away file, and a rename that started while the file was still being opened closed nothing. The close now waits its turn in that queue on every connected server, edits queued before it or arriving while it runs are not sent, and a later edit of the old path is dropped while no file exists there.
