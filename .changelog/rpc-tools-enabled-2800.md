---
section: Added
---

- **`tools.<name>.enabled` proven through a real pi RPC session (refs #2800)** — real-harness scenarios show a disabled tool absent from the tool list pi reports, the loader and MCP lifecycle tools refusing to be disabled with the config diagnostic, and `--no-tool` winning over config; the roster bytes pi receives per tool are measured on the wire.
