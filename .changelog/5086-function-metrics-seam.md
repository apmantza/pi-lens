---
section: Changed
audience: user
---

- **`high-complexity` now checks JavaScript files.** `.js`, `.jsx`, `.mjs`,
  and `.cjs` functions, and the `.mts` and `.cts` TypeScript modules, get the
  same cyclomatic and nesting warning as `.ts` and `.tsx`. One per-function
  metrics table per language now feeds the rule, the review graph, and the
  complexity report. Cognitive and nesting scores in `/lens-tdi` and the
  complexity report drop, because a `case` or `match` arm no longer scores on
  its own and a function no longer counts as a nesting level. Stored history
  keeps the old scale until each file is re-measured. A Python lambda now
  counts once, and a Python `except` counts as a decision. A code file with no
  metrics table (Java, Kotlin, C, and others) records one
  `function-metrics-language-unsupported` degradation per language per
  session.
  (closes #5086)
