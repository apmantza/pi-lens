---
section: Changed
---

- **Keep incomplete observation evidence separate from mutation attribution (refs #2984)** — hashless observational captures, including size-only changes, remain visible as unverifiable and never enter mutation replay, attribution, or the clean-observation latch.
