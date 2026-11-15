---
section: Fixed
audience: user
area: runners
---

- **oxlint and ESLint now find a root config for files inside a nested package.** The earlier fix did not take effect for an edit in a package, because the config search stopped at the package. It now stops at the project root, so a root config with a cwd-relative path, such as the `better-tailwindcss` `entryPoint`, no longer reports false findings. (refs #5631)
