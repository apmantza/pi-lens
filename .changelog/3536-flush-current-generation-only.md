---
section: Fixed
---

- A forced review-graph persist (the exit hook and `pi-lens build-graph`) no
  longer writes a snapshot generation that a newer one has already replaced.
  The persist worker handles requests concurrently, so a newer snapshot could
  land on disk while an older one was still in the worker; the forced write
  then put the older snapshot back, and the next build had to re-diff it. A
  superseded candidate is now dropped and logged as `persist_skipped` with
  reason `forced_flush_superseded`. The model is in
  `formal/review-graph-promotion/` (refs #3536).
