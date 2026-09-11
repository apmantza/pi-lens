---
section: Fixed
---

- **Stale inline blockers from non-LSP analyzers (refs #1561, #1461)** — The turn-end freshness sweep skipped every record whose provenance was not all-`lsp`, so a tree-sitter or ast-grep blocker was never checked against its own file. Combined with a retire path that can only claim coverage for registered language servers, such a record could not be cleared by any number of clean diagnostics runs and re-served every turn for the rest of the session. The sweep now checks the file's own drift for any record that carries provenance, keeping the forward-import walk for LSP-sourced records only; records with no recorded sources stay fail-closed. A widget row is no longer chained onto a self-only record, whose check cannot speak for the row's import axis.
