---
section: Fixed
audience: user
area: lsp
---

- **LSP command arguments now work with strict-schema providers.** `lsp_navigation` advertises the full JSON value space for `commandArguments`, so strict Responses tools no longer reject the tool while LSP servers still receive object arguments unchanged. (refs #5506)
