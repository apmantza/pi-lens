---
section: Fixed
audience: user
area: blockers
---

- **A seed copy no longer reaches `git add -A`.** For a Python file the earlier bytes reach ruff through its standard input, so no copy exists. Where a linter reads the disk, such as biome on TypeScript, the one-run copy is still written, and its name is first added to the repository's local `.git/info/exclude` (never a tracked `.gitignore`). (refs #5621)
