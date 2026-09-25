---
section: Fixed
---

- The install diagnostics block's unresolved-dependency note now names the compiled-binary cause (`bun build --compile`, the way pi ships) alongside the package-manager layouts, so a user on that host is no longer sent to inspect their package manager (refs #3424).
