---
section: Changed
audience: internal
---

- Let `bounded()` take its work as a thunk, `bounded((signal) => work, opts)`, run inside `spawnAbortScope` so a bound that fires aborts the scope its work runs in: the spawns and the requests that read `getAmbientAbortSignal()` (document symbols, code actions, and since #5097 the diagnostic pull and clean-confirm ping under `touchFile` and `getDiagnostics`) are cancelled instead of abandoned. Eight hook awaits that left work running now use it or carry a named reason in the `work` column of `BOUNDED_CALL_SITES`, and a new `bounded(` without that column reds. (refs #5550)
