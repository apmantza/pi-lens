---
section: Fixed
audience: internal
---

- **The local PR-body lint self-check keeps its time budget on a loaded runner.** The case that runs the preflight command in five argv forms launched its five `node` children one after another, so a loaded runner pushed it past the 5000 ms test timeout (941 ms idle, 8970 ms on a loaded CI shard). The five forms now run together, so the case costs its slowest single child, and each refusal is pinned by the rule text the child prints, not only by a non-zero exit. (refs #5597)
