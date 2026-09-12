---
section: Fixed
---

- **Bound the spawn usage sampler's concurrency, rate and lifetime (refs #2968)** — a poll tick no longer starts while the previous one is still querying the process table, the interval backs off once a child outlives the short-lived window, and polling stops at a cap derived from the spawn's own deadline; on Windows this ends the `powershell.exe`/`taskkill.exe` pile-up behind a child that never exits, and skipped ticks and capped samplers are counted on the degradation ledger.
