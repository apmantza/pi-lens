---
section: Fixed
audience: user
area: tools
---

- **Esc now stops the child processes a pi-lens tool call started.** `ast_grep_outline` and `ast_grep_replace` kill their ast-grep run when the call is aborted instead of running it to the end. An aborted `ast_grep_replace` apply changes no file when the abort lands before the write starts, and finishes the write when it lands during it. Tool installs and shared availability checks still run to completion. (refs #5097)
