---
section: Fixed
audience: user
area: host
---

- **Warm IPC connections now use explicitly bounded Unix socket paths.** Bind and connect operations no longer rely on Node implicitly truncating the socket-name portion of a long temporary-directory path. (refs #4353)
