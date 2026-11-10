---
section: Fixed
audience: user
area: lsp
---

- **A cold Deno server now gets seven seconds to answer a diagnostics check.** The pull wait fell back to the 1.5 second default, so a first check on a slow machine was abandoned and read as no answer. The new budget is only a ceiling, so a fast Deno answer returns at once. (refs #5464)
