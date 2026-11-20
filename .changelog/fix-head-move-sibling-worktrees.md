---
section: Fixed
audience: user
area: lsp
---

- **A checkout or rebase in a sibling worktree now refreshes the language server.**
  A bash command that moved HEAD in another linked worktree it named, or
  discarded edits there, left the server holding the old files with no record,
  so it reported errors against code that no longer existed. (refs #5718)
