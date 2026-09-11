---
section: Fixed
---

- **Scope project-diagnostics runner retirement by analyzed file coverage (refs #2887)** — opengrep findings retire only when the retained file appears in its reported `paths.scanned` set; other runners keep the conservative runner-id fallback.
