---
section: Changed
audience: internal
---

- Let `bounded()` take its work as a thunk, `bounded((signal) => work, opts)`, run inside `spawnAbortScope` so a bound that fires cancels the spawns and LSP requests under it instead of abandoning them. Eight hook awaits that left work running now use it or carry a named reason in the `work` column of `BOUNDED_CALL_SITES`, and a new `bounded(` without that column reds. (refs #5550)
