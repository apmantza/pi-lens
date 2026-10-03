---
section: Fixed
audience: user
---

- **`lsp_diagnostics` no longer counts unchecked files as clean (closes #3954)** — `details.cleanFiles` now matches `outcomeCounts.clean`; unsupported, unavailable and failed files are no longer reported as clean.
