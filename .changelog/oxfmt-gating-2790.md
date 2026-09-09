---
section: Changed
---

- **Make the oxfmt format check a CI gate (refs #2790, #2784)** — the workflow job now uses the gating name `oxfmt format check`, matching the hard `fmt:check` preflight gate and keeping formatting drift out of master.
