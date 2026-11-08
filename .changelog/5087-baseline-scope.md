---
section: Fixed
audience: internal
---

- **The first-touch complexity baseline stays in the session that took it.** `tool_call` captures the session before its awaits and writes the baseline store, and the metrics-history snapshot, through it, so a `/new` mid-capture no longer leaves the old session's file in the successor's store. The store now holds the file's function tables against the default branch, under an LRU bound. (refs #4220, #5087)
