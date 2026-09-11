---
section: Fixed
---

- **Marker-root freshness (refs #2922)** — Resolve the nearest marker with one synchronous walk per lookup, preserving visibility of nearer, created, and deleted markers without charging a redundant positive-cache rewalk.
