---
section: Fixed
audience: internal
---

- `scripts/check-tla-models.mjs` no longer runs any TLA+ config with TLC's
  `-workers auto`: a config that can violate more than one invariant could
  report a different one depending on how TLC's worker threads interleave
  under load. Every config now runs with a single, pinned worker, so its
  verdict is deterministic regardless of host contention (refs #3517).
