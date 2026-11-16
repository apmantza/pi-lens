---
section: Fixed
audience: user
area: lsp
---

- **Python servers now reach global fallbacks for adopted projects.** Refused project candidates no longer end a launch stage when installation is disabled. Project binaries remain refused, and when PATH reaches the project the later managed lookup reads only the pi-lens tool store. (refs #5674)
