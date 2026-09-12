---
section: Fixed
---

- **Keep deferred fixture roots tracked until their final drained cleanup pass (refs #2912)** — shared per-family cleanup drains deferred producers before untracking roots.
