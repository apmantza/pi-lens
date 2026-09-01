---
section: Fixed
---

- **Formatter config-signature lookup is warm-path cached (closes #1603)** — `findUp` reads each ancestor directory once, validates only matched entries, and rejects dangling links. The first lookup for a cwd computes one session-generation signature; concurrent extensions merge into one bounded cache entry, and warm selections do no configuration polling. The write-result seam invalidates selection for config create, change, and remove events, so formatter detection still re-runs without a per-call filesystem tax.
