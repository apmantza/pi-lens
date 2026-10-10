---
section: Fixed
audience: internal
---

- The nightly tool-smoke LSP capability census builds the in-place compiled twins immediately before it runs, so vitest no longer aborts on the stale-build guard (refs #4302).
