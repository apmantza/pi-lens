---
section: Changed
audience: user
---

- **`lsp_navigation` returns Neovim-style text by default (refs #1449)** — the tool and its MCP mirror `pilens_lsp_navigation` now answer with the text a Neovim LSP user sees: a `path:line:col` location list for definitions, references and call hierarchy, `hover` markdown, an indented `start-end kind name` symbol tree, `path:line:col: severity: message` diagnostic rows, and the rename summary. Pass `view: "json"` for the structured envelope from #261, unchanged; any other value falls through to text.
