---
section: Fixed
---

- **Prettier now carries repo-root `.prettierignore` via `--ignore-path` (closes #2756)** — `formatFile` spawns formatters with `cwd` set to the edited file's directory, which meant Prettier's default `.prettierignore` resolution (relative to cwd) never saw a repo-root ignore file. Ignored files were silently rewritten. The fix resolves `.prettierignore` by walking up from the file (same as config discovery) and passes the found path as `--ignore-path`, capped at `$HOME` so a home-level ignore Prettier would never read on its own is not adopted.