---
section: Fixed
---

- **Install managed formatters in the format smoke lane (closes #2767)** — The
  `--install` path now prefetches configured formatters through `ensureTool`
  and the formatter pipeline resolves those managed binaries.
- **Record unsupported formatter platforms as unavailable (refs #2767)** —
  GitHub and archive installs preserve the typed unavailable outcome when no
  asset exists for the host platform and architecture.
