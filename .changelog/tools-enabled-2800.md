---
section: Changed
---

- **Add per-tool enablement (refs #2800)** — `tools.<name>.enabled` and repeatable `--no-tool=<name>` prevent disabled lens tools from registering on the pi and MCP surfaces. The resolved state appears in `effective_config`.
