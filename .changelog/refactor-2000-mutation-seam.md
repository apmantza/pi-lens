---
section: Changed
---

- **ONE mutation seam: `RuntimeCoordinator.recordProjectMutation` (refs #2000 phase 1)** — the triplicated bump+change-log pairing (runtime-tool-result, runtime-agent-end, lsp-mutation) is consolidated onto one seam that bumps the seq store, appends a bounded attributed receipt ring (`getMutationsSince`, cap 512 with a surfaced dropped-count), and appends the durable change-log entry. Consumers derive touched-files answers from one store instead of three hand-copied pairings; phase 2's opaque-write recovery feeds the same seam.
