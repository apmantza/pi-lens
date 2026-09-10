---
section: Added
---

- **One session-end line names the tools never activated or called (refs #2800)** — a bounded debug record per session on both surfaces, keyed by the tool registry, so roster decisions can read which tools carried no weight in a session; the monitor readout gains the line. MCP owns the row for the connection and emits it at `pilens_session_end` or transport close, whichever comes first; repeated `pilens_session_start` calls refresh without clearing observations. Pi records the row for fresh sessions only: a reload, resume, or fork start suppresses the session's row entirely (conversation-owned accounting tracked in #2858).
