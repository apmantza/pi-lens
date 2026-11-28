---
section: Fixed
audience: user
area: blockers
---

- **A neighbour file rewritten with no language-server answer no longer loses the cascade error it held.** When a neighbour held an error that blocked `--lens-guard` commits and was then rewritten while the server gave no verdict, the next turn end forgot the error and admitted the commit with the error still in the file. The error now stays pending until a write that the server which raised it answered, a `lens_diagnostics source=lsp` probe or a cascade check clears it. A deferred format pass counts as unanswered, and so does a late clean answer. An ast-grep or typos answer now clears that server's errors too, unless it still reports one outside the edited lines. An opengrep error waits for a probe or cascade check. (refs #5804)
