---
section: Fixed
audience: user
area: lsp
---

- **Esc now cancels the diagnostic pull and the clean-confirm ping a cut-off check had started.** A turn-end re-verify or an enrichment pass that hit its bound used to leave `textDocument/diagnostic` running on the language server; it now sends `$/cancelRequest`. A warm-up that Esc cut is no longer remembered as a cold server. (refs #5097)
