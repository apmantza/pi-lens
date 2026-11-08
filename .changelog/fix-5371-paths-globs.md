---
section: Fixed
audience: user
area: tools
---

- **A `paths` glob now finds the same files in every tool.** `paths: ["src/**/*.ts"]` searched the workspace in `symbol_search`, reached the ast-grep CLI as a file name and answered "No matches found", and on `source=lsp` reported `path not found`. A glob now expands once against the call's own root. A path that exists is always a literal, so `app/[id]/page.tsx` keeps working. A glob that matches nothing says `no file matches`, one rooted outside the workspace is refused, and an entry starting with `!` is refused. (refs #5371)
