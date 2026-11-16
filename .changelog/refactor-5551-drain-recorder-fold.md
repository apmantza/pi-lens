---
section: Changed
audience: internal
---

- The agent_end drain's format and autofix writes record through the mutation bridge's one body, `recordMutationOutcome`, as a `drain` writer, so its two hand-copied recorders are gone; the direct LSP branch names its change-log row through the same `source` option. (refs #5551)
