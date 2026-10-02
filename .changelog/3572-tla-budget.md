---
section: Changed
audience: internal
---

- `scripts/check-tla-models.mjs` runs `formal/*/*.cfg` through a
  concurrency pool sized to the host's CPU count instead of one config at a
  time, and prints per-directory timing so a future model's cost is visible
  in the `TLA+ models` job log without re-deriving it by hand (refs #3572).
