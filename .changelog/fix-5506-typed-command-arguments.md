---
section: Fixed
audience: user
area: lsp
---

- **LSP command arguments opt out of strict schema conversion.** `lsp_navigation` advertises the full JSON value space for `commandArguments` without a strict opt-in, so providers can receive object arguments unchanged. Live confirmation on a strict-schema provider remains outstanding. (refs #5506)
