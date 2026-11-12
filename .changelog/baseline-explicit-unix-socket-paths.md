---
section: Fixed
audience: user
area: host
---

- **Warm IPC never crosses workspaces under a long temporary directory.** Bind and connect use the bounded Unix socket path, so a `TMPDIR` that cuts only the `.sock` suffix keeps the warm side channel on hosts that reject an over-long socket path with `EINVAL`. A longer `TMPDIR` cuts the workspace identity out of the name: the MCP server does not bind it, no hook dials it, the server logs that the warm side channel is unavailable, and hooks fall back to cold analysis. (refs #4353)
