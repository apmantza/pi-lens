---
section: Fixed
---

- **Formatters now run from the project root (closes #2756)** — `formatFile` uses the nearest formatter config or `.gitignore`, with a real `.git` fallback capped at `$HOME`, so `.prettierignore`, `.gitignore`, and cwd-discovered configs resolve as at the CLI. Prettier, Biome, and oxfmt are covered.
