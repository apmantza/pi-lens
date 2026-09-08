---
section: Changed
---

- **Cleared 26 unused test exports and 28 unused exported test types (refs #2708)** — test-support APIs are now private where their consumers are local, while the packaging workflow's pinned `publint` dependency remains declared and documented to Knip.
