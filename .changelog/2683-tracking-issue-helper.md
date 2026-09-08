---
section: Changed
---

- **Nightly tracking-issue updates share one reusable CLI (closes #2683)** — compat-smoke, install-smoke, and clean-signal drift use one exact-title issue seam that fails loudly on a GitHub error and searches beyond the first page; both smoke workflows now auto-close their tracker on a clean run.
