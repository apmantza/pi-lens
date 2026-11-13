---
section: Fixed
audience: user
area: runners
---

- **oxlint and ESLint now run in the directory of their config.** A repo-root config with a path that a plugin resolves from the working directory no longer reports false findings for files under a nested workspace package, while the lint policy and the install lookup stay in the package. (refs #5541)
