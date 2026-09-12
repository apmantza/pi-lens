---
section: Fixed
---

- **Preserve the analysed file state across concurrent writes (closes #2499)** — The dispatch latch now records the state the pipeline actually analysed. The LSP batch pool preserves its abort contract: unstarted files do not add placeholder outcomes to aggregate diagnostics.
