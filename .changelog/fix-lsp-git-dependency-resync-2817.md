---
section: Fixed
---

- **Re-sync LSP diagnostics after Git tree changes (refs #2817)** — open documents and bounded cached import dependencies are touched before scoped full diagnostics serve cached results; files without import-fact coverage receive a fresh requested-file touch; **Prove language-neutral LSP dependency resync through the real server path** (refs #2817); the shared drift pass gives a Git-queued file one resync opportunity even when ordinary stat drift identifies the same file in that pass.
