---
section: Fixed
---

- **Spawn-cwd scanner derives one vocabulary from the seam and freezes (closes #2927)** — the scan's site rule and the sweep's population predicate both derive from the `SPAWN_NAMES` / `NODE_SPAWN_NAMES` tuples, with per-name parity tests; the `// cwd-exempt:` channel stays as the documented escape hatch; the scanner header states the simplify-not-extend freeze policy.
