---
section: Fixed
audience: user
area: config
---

- **MCP sessions now reset when config files change.** `resolvePiLensConfig` records 3-state `inspectedConfigSources` digests (`absent`, `unreadable`, and `readable` with `parsed`, `sha256`, and `byteLength`), `pilens_effective_config` surfaces them home-relativized, and MCP session entry points reset any cached or in-flight bootstrap context with `mcp-session-reset` whenever inspected sources change. A config file larger than 1 MiB is now refused with a read error naming its size, and its settings do not apply; earlier versions read config files of any size. (refs #1570, #2426)
