---
section: Fixed
---

- **Install managed formatters in the format smoke lane (closes #2767)** — The
  `--install` path now prefetches configured formatters through `ensureTool`
  and the formatter pipeline resolves those managed binaries.
