---
section: Fixed
---

- **Keep alternate language servers as fallbacks during all-scope diagnostics (closes #2400)** — An aggregate LSP pass no longer launches Deno, Jedi, OmniSharp, or Expert beside a working preferred server. The alternate still starts when its preferred server is unavailable.
