---
section: Fixed
audience: user
area: blockers
---

- **A neighbour file rewritten with no language-server answer no longer loses the cascade error it held.** When a neighbour held an error that blocked `--lens-guard` commits and was then rewritten while the server gave no verdict, the next turn end forgot the error and admitted the commit with the error still in the file. The error now stays pending until a write that the server which raised it answered, a `lens_diagnostics source=lsp` probe or a cascade check clears it. A write nothing analysed, such as a deferred format pass, counts as unanswered. A rewrite answered by an auxiliary server such as ast-grep or opengrep now clears that server's errors too, and a late clean answer from the primary server keeps them. (refs #5804)
