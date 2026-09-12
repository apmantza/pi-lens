---
section: Added
---

- **Allow an explicit analysis root below the home ceiling (closes #2053)** — `lens_diagnostics mode=full` can run heavyweight analyzers for a named, existing project directory when the session cwd is `$HOME` or higher, while retaining the #749 refusal for unsafe roots.
