---
section: Fixed
audience: user
---

- **Agent-facing guidance names the tools the agent's host can call.** The session-start situational bullet listed three of the five lazy tools (`ast_grep_outline` and `lens_diagnostic_mark` were missing); it now derives its list from the tool registry, skips a tool disabled by `tools.<name>.enabled`, and under MCP names only the tools MCP can call. The ast-grep no-match hint likewise told every caller to use `symbol_search`, `module_report`, `lsp_navigation` and `ast_grep_search`, none of which an MCP client can call by that name, and now renders through the same host translation (#4682, #4809).
