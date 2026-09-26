---
section: Fixed
---

- **An older read of a file no longer overwrites a newer write on the language server (closes #3481)** — the cascade reads a neighbouring file, waits, and only then sends it to the server. When the agent edited that file in the meantime, the cascade's older copy queued behind the edit's own sync and was sent last; for an edit that kept the file's length, the drift check could not notice and the server kept the old text until the file was touched again. Two same-turn syncs of one file raced the same way. The post-write sync, the cascade, the drift check's resync, the dispatch runner and the tool-call warm-up now say when they read the file, and each file's send queue keeps the most recent read: an older read never replaces a newer one that is waiting, and is dropped if something newer was already sent. A dropped read that was a save still sends the save.
