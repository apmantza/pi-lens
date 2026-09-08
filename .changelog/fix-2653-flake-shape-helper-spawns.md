---
section: Fixed
---

- **The flake-shape ratchet now sees child processes routed through test support helpers (refs #2653)** — code-channel calls to `gitFixtureSpawnAsync`, `safeSpawnAsync`, and the other support helpers that reach `node:child_process` now join the real-process census.
