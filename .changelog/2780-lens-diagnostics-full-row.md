---
section: Added
audience: internal
---

- **Add a nightly `lens_diagnostics mode=full` row** (closes #2780) — the tool-smoke workflow now drives the real `lens_diagnostics` handler with `mode=full refreshRunners=cheap` over one seeded fixture and requires a primary LSP finding, mirroring the `lsp_diagnostics` clean gate.
