---
section: Added
---

- The LSP capability inventory (`docs/servercapabilities.md`) now has a `save` column recording each server's `textDocumentSync.save`: `save` receives `textDocument/didSave`, `save+text` receives it with the document text, and `?` marks a server the generating host did not capture (refs #3407).
