---
section: Added
audience: internal
---

- Adds a nightly live cascade lane to the tool-smoke workflow: for typescript-go, rust-analyzer, gopls and jdtls it edits an exporter, calls the production cascade, and reds when an importer does not reach a conclusive verdict with the server's own finding (refs #1712). The first measured time-to-conclusive per server is committed in `tests/fixtures/lsp-cascade/measurements.json`.
