---
section: Fixed
audience: user
area: blockers
---

- **A commit is no longer refused over a blocker that was already in the file.** `ast_grep_replace`, `sed -i`, an unclassified tool and an LSP rename now take the same pre-edit baseline as a host `edit`, so an unrelated change through them to a file that holds a committed `debugger;` commits. A blocker the writer adds is still refused. (refs #5553)
