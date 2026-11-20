---
section: Changed
audience: internal
---

- Four process-wide slots (the spawn-timeout cooldown, the opaque baseline store, the probe-home memo and safe-spawn's lifetime registry) now live behind `getProcessSingleton`, and a new sweep (`tests/config/process-slot-sweep.test.ts`) reds a hand-rolled `globalThis`, `Symbol.for` or `process` slot outside it. (refs #4907)
