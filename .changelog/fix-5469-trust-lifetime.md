---
section: Fixed
audience: user
area: lsp
---

- **Adopted trust reads no longer retain LSP starts or shutdown when host SDK loading stalls.** Detached tools and background acquisitions reread saved trust instead of retaining a decision without an owning turn. (refs #5469)
