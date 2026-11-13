---
section: Fixed
audience: user
area: runners
---

- **Lint findings now appear for files a linter had silently skipped.** `yamllint` and `markdownlint` were handed the absolute path of the dispatched file, and both match their config's ignore globs against that string, so a glob naming an ancestor of the file (such as `**/.claude/**` inside a `.claude/worktrees/` lane) skipped the file: the tool answered "no files selected", exited 0, and the runner reported a clean file it had never linted. Both now receive the path relative to the project, the form `actionlint` already uses, so a root-anchored ignore such as yamllint's `/src/` or markdownlint's `/src/**` now skips the files under it, which the absolute path had linted. A root-level name such as `-a.yml`, `#a.md` or `:a.md` is still read as a path, and `--fix` gets the same argument. (refs #5544)
