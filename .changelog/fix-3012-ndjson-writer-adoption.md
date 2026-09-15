---
section: Fixed
---

- **Adopt NDJSON rotation bounds across extension reloads (closes #3012)** — an older unbounded writer adopts incoming bounds during module-graph re-evaluation, while conflicting bounded policies retain first-writer ownership and emit one bounded health record.
