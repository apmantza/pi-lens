---
section: Fixed
audience: user
area: lsp
---

- **`lens_diagnostics` in full mode now keeps one rule's findings apart when their columns differ.** Findings that share a rule and line now stay separate by column. LSP hints were already listed as warnings; only their semantic label now matches the CLI advisory tier. (refs #5412)
