---
section: Changed
---

- **Cleared 51 of the 54 knip rows (23 of the 26 unused test exports; the 3 flake-shape rows stay for #2742) and 28 unused exported test types (refs #2708)** — test-support APIs are now private where their consumers are local, while the packaging workflow's pinned `publint` dependency remains declared and documented to Knip.
