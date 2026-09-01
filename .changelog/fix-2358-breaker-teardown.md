---
section: Fixed
---

- **Breaker teardown tells dead from busy (#2358).** The LSP notify-stall breaker
  grants a wedged scanner an adaptive patience window (per-write drain latency
  x backlog depth) and samples its process CPU before any kill. A server that
  is burning a core while it drains a burst is left alone and re-armed, not
  torn down; only a flat-CPU or cap-exceeded server is killed, and the teardown
  record names which discriminator fired. Windows CPU sampling now resolves
  `powershell.exe` through `System32`, which was silently missing before.
  Streak teardown releases TypeScript idle-timer ownership before the asynchronous
  CPU probe and re-arms it only when the same client remains busy. Notify timers
  now release with their client generation, and stale decisions cannot demote a
  replacement. Windows CPU history includes CIM process-creation identity, so
  PID reuse starts a fresh rate window. Missing targets and failed queries remain
  unmeasured, while busy-defer detail is bounded per client/file identity. CPU
  counters are validated and history is capped; decision rows stay out of
  last-phase attribution.
