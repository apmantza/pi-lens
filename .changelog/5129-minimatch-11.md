---
section: Fixed
audience: user
---

- **The bundled `minimatch` is updated to 11.x for GHSA-g3hv-75wg-m249.** The published package inlines `minimatch`, so scanners flagged the 10.2.6 copy for a crafted glob that amplifies `globParts` when `optimizationLevel` is 2 or higher. pi-lens never sets `optimizationLevel` (the default is 1), so no pi-lens glob reached the vulnerable path; the dependency is now `^11.0.1`, and the lockfile resolves 11.0.3. One gitignore-style entry changes: a zero-width extglob such as `?(x)` or `*(x)` no longer matches every directory. (refs #5129)
