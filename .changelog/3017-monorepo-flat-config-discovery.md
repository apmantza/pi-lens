---
section: Fixed
---

- **Discover monorepo-root ESLint and Oxlint configs across nested `package.json` boundaries (refs #3017)** — flat `eslint.config.{js,mjs,cjs,ts,mts,cts}` files and Oxlint configs now resolve from every ancestor directory like the tools themselves, so the jsts lint lane defers Biome with the machine-readable `configured-non-biome-linter` skip reason instead of running the smart default; legacy `.eslintrc.*` and `package.json#eslintConfig` keep per-package semantics.
