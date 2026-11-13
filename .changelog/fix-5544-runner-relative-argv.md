---
section: Fixed
audience: user
area: runners
---

- **Lint findings now appear for files a linter had silently skipped.** `yamllint` and `markdownlint` were handed the absolute path of the dispatched file, and both match their config's ignore globs against that string, so a glob naming an ancestor of the file, or a root-relative one such as `.claude/worktrees/`, skipped the file: the tool answered "no files selected", exited 0, and the runner reported a clean file it had never linted. Both now receive the path relative to the project, the form `actionlint` already uses, spelled so a root-level name like `-a.yml` or `#a.md` still reads as a path, and `--fix` sees it too. (refs #5544)
