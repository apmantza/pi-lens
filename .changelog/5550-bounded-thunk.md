---
section: Changed
audience: internal
---

- Let `bounded()` take its work as a thunk, `bounded((signal) => work, opts)`, run inside `spawnAbortScope` so a bound that fires aborts the scope its work runs in: the spawns and the requests that read `getAmbientAbortSignal()` (document symbols, code actions) are cancelled instead of abandoned, while `touchFile` and `getDiagnostics` do not read it yet and wait on #5097. Eight hook awaits that left work running now use it or carry a named reason in the `work` column of `BOUNDED_CALL_SITES`, and a new `bounded(` without that column reds. (refs #5550)
