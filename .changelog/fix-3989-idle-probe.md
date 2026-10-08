---
section: Fixed
audience: internal
---

- **Idle-eviction measurements cover temporary checkouts (refs #3989)** — The nightly probe now arms the short idle window used by ephemeral LSP roots as well as the generic window, so eligible servers are measured instead of reported as not evicted.
