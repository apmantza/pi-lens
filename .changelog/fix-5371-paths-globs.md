---
section: Fixed
audience: user
area: tools
---

- **A `paths` glob now finds the same files in every tool.** `paths: ["src/**/*.ts"]` searched the whole workspace in `symbol_search`, handed the pattern to the ast-grep CLI as a file name and answered "No matches found", and on `source=lsp` reported `path not found` — a clean that was never checked. A glob now expands once, against the call's own root, and a glob that matches nothing says `no file matches`. An entry starting with `!` is refused: it would name everything the pattern leaves out, which is the opposite of a target list.
