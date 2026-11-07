---
section: Changed
audience: user
area: host
---

- **MCP tool schemas now come from the pi tool definitions they mirror.** `pilens_symbol_search` and `pilens_project_report` advertise the pi tools' own parameter descriptions, tool cross-references and `cwd` text, so the two surfaces cannot drift apart. `pilens_module_report`, `pilens_read_symbol`, `pilens_read_enclosing`, and `pilens_effective_config` keep their current schemas: their pi definitions do not declare the `file`/`filePath` aliases those entries accept, so replacing them would change what MCP callers may send. (refs #5138)
