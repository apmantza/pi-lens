---
section: Added
audience: internal
---

- **Four fast-check tests turn the 2026-11-07 property-based probes into regression tests (refs #3995)** — a two-session model for the per-repository commit gate and the per-session change-log stamp (#4952, #4953), a generated-K session-root eviction property (#4734), a generated venv-install property (#5009), and a concurrent-publisher property for the recent-touches record (#5385). Each runs a bounded `numRuns` under seed 5370 and is red on its bug's parent commit. No runtime path changes.
