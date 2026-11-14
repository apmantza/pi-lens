---
section: Fixed
audience: user
area: blockers
---

- **The commit gate now refuses a blocker the staged lines add, whoever wrote them.** Under `--lens-guard`, a `debugger;` that a script, a tool that names no path or an external editor adds no longer commits unchecked. The gate dry-runs the command's commit with `git`, after the usual steps before it (`git add`, `git rm`, `git mv`, `cd`, `export`, `make`, `npm test`). It runs the linters, ast-grep and tree-sitter over the committed bytes, not LSP or type checks. It refuses only on a line the commit adds. A linter with no answer, a read past its time, or a step it cannot replay refuses (a script or `git reset` before the commit): run that first, then commit. (refs #5553)
