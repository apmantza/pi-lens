---
section: Fixed
---
- **LSP and smoke harness scratch directories use liveness-gated cleanup (closes #2688, closes #2687)** — shared per-run scratch directories record their owner process, preserve live workspaces, remove dead or aged orphaned entries, and announce each scratch home for reliable telemetry discovery.
