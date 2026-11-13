---
section: Fixed
audience: user
area: runners
---

- **oxlint now runs in the directory of its own config.** A repo-root config with a path that a plugin resolves from the working directory no longer reports false findings for files under a nested workspace package. (refs #5541)
