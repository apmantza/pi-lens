---
section: Fixed
audience: user
area: tools
---

- **A file no check completed on is no longer reported as clean.** `lens_diagnostics` now names such files as not checked instead of opening with "No issues ✓", the footer stops counting kinds nothing can check, and `pi-lens-analyze` and `pilens_analyze` print the reason instead of exiting silent. The default cold hook pass over TypeScript now prints a not-checked line, because it runs without a language server. One wording now covers a file no language server handles, and the mode=full sweep names an enabled opt-in server as not run. (refs #5287)
