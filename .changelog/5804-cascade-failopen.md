---
section: Fixed
audience: user
area: blockers
---

- **A neighbour file rewritten with no language-server answer no longer loses the cascade error it held.** When a neighbour held an error that blocked `--lens-guard` commits and was then rewritten while the server gave no verdict, the next turn end forgot the error and admitted the commit with the error still in the file. The error now stays pending until a write answered by the source that raised it, a `lens_diagnostics source=lsp` probe or a cascade check clears it; a write that was never analysed counts as unanswered. A late clean answer from the primary server also keeps the rows an auxiliary server raised. (refs #5804)
