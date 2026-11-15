---
section: Changed
audience: user
area: blockers
---

- **A `lens_diagnostic_mark` suppress now dispatches the file it wrote.** The files a call wrote through the mutation bridge, such as an `ast_grep_replace` or an `lsp_navigation` rename, reach the dispatcher and the commit gate whatever the tool is named, and under any host call id, including OpenAI Responses ids that contain a pipe or pass 64 characters. (refs #5551)
