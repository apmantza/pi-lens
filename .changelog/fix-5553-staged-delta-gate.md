---
section: Fixed
audience: user
area: blockers
---

- **The commit gate now refuses a blocker the staged lines add, whoever wrote them.** Under `--lens-guard`, a script, a tool that names no path or an external editor that adds a `debugger;` no longer commits unchecked. The gate reads the files the commit carries from `git`, and refuses a blocker only on the lines the commit adds against `HEAD`, so an unrelated change to a file whose blocker is already committed still commits. A file staged clean and then edited, or a read that gives no answer in time, refuses until you stage it again or retry. (refs #5553)
