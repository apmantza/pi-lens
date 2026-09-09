---
section: Fixed
---

- **Route built-in LSP roots through the tool-cwd seam and expose resolved cwd in `lens_diagnostics` (refs #2777)** — Built-in server marker tables now use the shared bounded resolver, and diagnostic rows identify the cwd used for their language server.
