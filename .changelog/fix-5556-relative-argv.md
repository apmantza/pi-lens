---
section: Fixed
audience: user
area: runners
---

- **Oxlint now lints files in ignored-ancestor worktrees.** The lint and autofix
  paths now pass the project-relative file argument, so an `.eslintignore` glob
  naming an ancestor cannot silently make oxlint skip the dispatched file.
  Findings remain attributed to the dispatched path. (refs #5556)
