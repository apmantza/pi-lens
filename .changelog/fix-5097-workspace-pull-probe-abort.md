---
section: Fixed
audience: user
area: lsp
---

- **Esc now cancels a project-wide diagnostics pull and a TypeScript project probe.** A `lens_diagnostics` full scan and the `projectInfo` request sent when a TypeScript file opens used to keep waiting on the language server after you aborted. Both now send a cancel and return at once. (refs #5097)
