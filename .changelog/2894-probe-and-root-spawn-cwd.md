---
section: Changed
---

- **Tool probes and hand-derived package roots resolve through shared seams (refs #2894)** — a `probeToolAsync` seam owns the "a presence/version probe never gets a `cwd`" contract for 23 spawn sites that each decided it locally, `rust-clippy` takes its package root from `resolveRunnerCwd` (with `Cargo.toml` registered as its runner marker) instead of an uncapped `findNearestContaining` walk, and `ruff-client`'s autofix resolves its config root through `resolveToolCwd` so a file in a nested package gets that package's `pyproject.toml` rather than the workspace one.
