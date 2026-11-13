---
section: Fixed
audience: user
area: runners
---

- **Lint findings now appear for files a linter had silently skipped.** `yamllint` and `markdownlint` were handed the absolute path of the dispatched file, and both match their config's ignore globs against that string. A project whose ignore list names an ancestor of the file, such as a worktree lane under `.claude/`, therefore answered "no files selected", exited 0, and the runner reported a clean file it had never linted. Both now receive the path relative to the project, the form `actionlint` already uses. (refs #5544)
