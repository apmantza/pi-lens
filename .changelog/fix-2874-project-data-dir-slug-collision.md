---
section: Fixed
---

- **Project data directory slug carries a path hash (closes #2874)** — Projects whose paths differ only in separator placement versus a hyphen no longer share one data directory; on first use after upgrade, the existing directory is renamed once so caches and session state carry over.
