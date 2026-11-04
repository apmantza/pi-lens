---
section: Fixed
audience: user
---

- **Applied `ast_grep_replace` and LSP rename or command edits are now checked like an `edit`.** This covers an `lsp_navigation` rename, `rename_file` and `executeCommand`. The files they write go through dispatch, so a blocker the write introduces reaches the turn-end check and `git commit` under `--lens-guard` refuses it, and a multi-file apply is no longer cut short by the read-only tool-result wall (#5239, #5248).
