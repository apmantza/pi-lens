---
section: Fixed
---

- **Re-sync LSP diagnostics after Git tree changes (refs #2817)** — open documents and bounded cached import dependencies are touched before scoped full diagnostics serve cached results; files without import-fact coverage receive a fresh requested-file touch.
