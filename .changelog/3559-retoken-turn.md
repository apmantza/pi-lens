---
section: Fixed
audience: user
---

- **An analysis that finishes after its turn ended is recorded under the turn it finished in (closes #3559)** — When pi-lens' own autofix rewrote a file after the next edit had already been analysed, pi-lens analysed the fixed bytes under a fresh write number. If the turn had ended meanwhile, that number was filed under the old turn, so the newer result looked older than the next edit's and was dropped, leaving the blocker for bytes that no longer exist. The fresh number now carries the turn it was drawn in.
