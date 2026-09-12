---
section: Fixed
---

- **Opengrep scan refusal reporting (closes #2943)** — Canonicalize symlinked workspace roots, preserve findings from partial-parsing warnings, classify every report and spawn failure once, and surface refused scans as cold diagnostics with machine-readable reasons. The outcome matrix now pins clean non-zero exits, every report discriminator, and the cached empty-coverage shape.
