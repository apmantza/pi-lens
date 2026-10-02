---
section: Fixed
audience: user
---

- Report unknown MCP tool arguments instead of silently ignoring them: a call whose argument keys are not in the tool's advertised `inputSchema` (for example `pilens_diagnostics {"filePath": ...}` where the schema says `path`) now starts with an `Ignored unknown argument(s) for <tool>: ...` line naming the keys and the nearest valid key, carries `structuredContent.ignoredArguments`, and is counted in the `mcp-ignored-arguments` degradation row. When an ignored key leaves a schema-required input missing, or is a declared parameter the call did not send written another way (`filePath`, `file_path` or `Path` for `pilens_diagnostics`'s optional `path`; the predicate is named in `docs/public-api-stability.md`), the tool returns an error instead of running on defaults; a looser "did you mean" (a typo, `files` for `maxLspFiles`) stays a warning and the tool runs. A non-object `arguments` is now a JSON-RPC `-32602` error. Unknown keys are still not rejected outright; that stays with the #2418 stability policy (closes #3749).
