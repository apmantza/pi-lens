---
section: Fixed
audience: user
area: blockers
---

- **The commit gate now refuses a blocker the staged lines add, whoever wrote them.** Under `--lens-guard`, a script, a tool that names no path or an external editor that adds a `debugger;` no longer commits unchecked. The gate asks `git` what the commit carries (a dry run of the command's own commit) and runs the linters, ast-grep and tree-sitter lanes over the committed bytes; it does not run the LSP or type-check lanes. It refuses a blocker only on a line the commit adds, so an unrelated change to a file whose blocker is already in `HEAD` still commits. A linter that gives no answer, a read that runs out of time, or a command it cannot replay before it runs (`npm test && git commit`) refuses; run the other commands first, then commit on its own. (refs #5553)
