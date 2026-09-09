---
section: Fixed
---

- **Flake-shape ratchet governs support-helper waits (refs #2563, #2784)** — the contention ratchet scans `.ts` and `.mts` support helpers, resolves aliased timers, and requires every support baseline row to carry a detector-specific reason, header, and serialized-lane proof through its importing tests.
