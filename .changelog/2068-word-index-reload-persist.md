---
section: Fixed
---

- **Keep word-index persists incremental after a session reload (refs #2068)** —
  `deserializeWordIndex` now seeds dirty-file tracking and the wire cache, so
  the first persist of a reloaded session takes the bounded incremental path
  instead of a full re-serialize, and later per-edit persists in that session
  no longer silently drop edits from the persisted snapshot. Sanitized or
partial snapshots use a full canonical re-serialize instead of republishing
discarded wire lanes. Legacy snapshots without the forward lane remain
compatible, but never seed the raw incremental cache.
