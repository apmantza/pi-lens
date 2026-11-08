---
section: Fixed
audience: user
area: tools
---

- **Esc now stops the child processes a pi-lens tool call started.** `ast_grep_outline`, `ast_grep_replace` and the scanners behind `lens_diagnostics` are killed when the call is aborted instead of running to the end, and `lsp_navigation` cancels its language-server request. An aborted `ast_grep_replace` apply changes no file when the abort lands before the write starts, and finishes the write when it lands during it, so a file set is never left half rewritten. Tool installs and shared availability checks still run to completion. (refs #5097)
