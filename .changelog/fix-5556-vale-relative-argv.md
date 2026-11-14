---
section: Fixed
audience: user
area: runners
---

- **Vale now reads the `.vale.ini` sections that name your project's files.** The runner handed Vale the absolute path, so a section such as `[docs/*.md]` never matched, and a section naming an ancestor directory (`[**/.claude/**]` in a Claude Code worktree) matched the project's own files and silenced them. Vale now gets the project-relative path, with a `./` prefix for a name that starts like an option. (refs #5556)
