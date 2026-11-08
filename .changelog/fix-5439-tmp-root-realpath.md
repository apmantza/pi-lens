---
section: Fixed
audience: internal
---

- The four path-sensitive test files (`effective-config`, `lens-diagnostic-mark`, `lens-diagnostics`, `lsp-navigation`) now build their temp roots by realpath through `mkdtempRealSync()`, so a symlinked `TMPDIR` (macOS `/var` to `/private/var`) passes them the way the real root does (refs #5439).
