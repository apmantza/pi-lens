---
section: Fixed
---

- **Drain and track lens-map fixtures (refs #2912)** — route lens-map temporary roots through the shared environment registry so deferred graph writes cannot recreate an untracked `/tmp` root after teardown.
