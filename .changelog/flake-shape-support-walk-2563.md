---
section: Fixed
---

- **Flake-shape ratchet walks tests/support helpers (refs #2563, #2784)** — the contention ratchet now also scans every non-test helper under `tests/support/` with the time detectors, so a raw-timer wait or `vi.waitFor` hidden inside a shared primitive is counted instead of reaching every importing test file uncounted; a `delay`/`sleep` helper definition in a support file is flagged too, which catches a timer aliased away from the raw-call shape.
