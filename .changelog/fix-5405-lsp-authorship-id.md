---
section: Fixed
audience: user
area: blockers
---

- **An LSP rename no longer costs an extra read after /tree or /fork.** On OpenAI Responses sessions the tool-call id carries a pipe, and the write record of an `lsp_navigation` rename or code action kept that raw id, so a branch move dropped it. The record now keeps the same sanitized id the branch holds, and the next edit of the renamed file is allowed. (refs #5405)
