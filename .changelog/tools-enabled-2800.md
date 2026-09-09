---
section: Changed
---

- **Add per-tool enablement (refs #2800)** — `tools.<name>.enabled` and repeatable `--no-tool=<name>` prevent disabled lens tools from registering on the pi and MCP surfaces. One registry now covers every model-facing tool, keeps the activation and MCP lifecycle tools non-disableable, and emits stable diagnostic code `PILENS_CFG_0009` for unknown or non-disableable keys. The resolved state appears in `effective_config`.
