---
section: Changed
---
- **Fold `lsp_diagnostics` into `lens_diagnostics` with source and scope modifiers; retain the MCP compatibility shim for one release.** (refs #2800)
  Deprecated: `pilens_lsp_diagnostics` remains accepted by MCP for one release and maps to `source=lsp`.
