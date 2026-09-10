---
section: Fixed
---

- **`lens_diagnostics mode=full` retires a stale finding only when the result that replaces it is genuinely authoritative: an LSP write the ordering guard accepted, or a project runner that actually analysed the root this call. A runner that reported success without running — no project root, no source files, a scan that crashed before writing its report — is reported cold instead of silently deleting the finding, and a retained result that could not be reconciled is labelled stale rather than served as a current blocker (refs #2154).**
