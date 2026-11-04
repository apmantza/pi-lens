---
section: Fixed
audience: user
---

- **An applied `ast_grep_replace` and an applied `lsp_navigation` rename, `rename_file` or `executeCommand` are now checked like an `edit`.** The files they write go through dispatch, so a blocker the write introduces reaches the turn-end check and `git commit` under `--lens-guard` refuses it, and a multi-file apply is no longer cut short by the read-only tool-result wall (#5239, #5248).
