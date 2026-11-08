---
section: Changed
audience: user
area: host
---

- **`path` is now the only file argument the MCP tools advertise.** `pilens_module_report`, `pilens_read_symbol`, `pilens_read_enclosing` and `pilens_effective_config` take their schema and description from the pi tool definition, which names `path` alone, so a model reading the tool list is never sent to `file` or `filePath`. A `file`-only call to the three read tools is now refused as a missing `path`; `pilens_effective_config` still answers one, with the ignored-argument notice. `pilens_analyze`, `pilens_diagnostics` and `pilens_lsp_navigation` keep both aliases. (refs #5138)
