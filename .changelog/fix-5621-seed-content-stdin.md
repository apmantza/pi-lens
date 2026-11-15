---
section: Fixed
audience: user
area: blockers
---

- **A credited write over a Python file no longer leaves a seed copy beside it.** The earlier bytes now reach ruff through its standard input, so a concurrent `git add -A` has nothing to stage. Files whose linters read the disk, such as TypeScript with biome, still use the copy for the run. (refs #5621)
