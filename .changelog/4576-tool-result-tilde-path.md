---
section: Fixed
audience: user
---

- **`~/` paths now resolve where the shell, the disk, and the tool argument really point (closes #4576)** — a `tool_result` shares the `tool_call` resolver, so writes through `~/…` no longer dispatch runners against a `<projectRoot>/~/…` path that never existed; a bash operand follows shell rules again (a quoted `'~/x'` stays literal, and `@x`, a `file://` spelling or a no-break space are the file names a shell opens); a write recovered from disk keeps its byte-exact name; and `module_report`, `lens_diagnostic_mark`, `lsp_diagnostics` and `lsp_navigation` expand a `~` path argument instead of looking for it under the session cwd.
