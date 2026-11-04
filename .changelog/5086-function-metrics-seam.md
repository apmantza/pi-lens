---
section: Changed
audience: user
---

- **`high-complexity` now checks JavaScript files.** `.js`, `.jsx`, `.mjs`
  and `.cjs` functions get the same cyclomatic and nesting warning as
  TypeScript. One per-function metrics table per language now feeds the rule,
  the review graph and the complexity history, which gains real parameter
  counts and no longer counts a Python lambda twice. A code file with no
  metrics table (Java, Kotlin, C, and others) records one
  `function-metrics-language-unsupported` degradation per language per
  session instead of silently getting nothing.
  (closes #5086)
