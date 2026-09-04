---
section: Fixed
---

- **Overlap auxiliary LSP warmup with primary server during resync (closes #2540)** — on cold first edit, auxiliary LSP server acquisition is kicked off concurrently and unawaited via deferred LSP work at resync time, overlapping auxiliary warmup with the primary language server. Bounded per server by `bounded()` using the ambient turn signal and caller hook attribution, dropping cold two-server edit latency from the sum of both spawns to the slowest single spawn. Auxiliary readiness duration is pushed to the latency log under the `auxiliary_readiness` phase.
