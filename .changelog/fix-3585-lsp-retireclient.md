---
section: Fixed
audience: user
---

- **A retired LSP client's drain-latency estimate no longer prices its replacement, and the workspace sweep no longer counts a refused write as backlog (refs #3585)** — capacity eviction, TypeScript idle eviction, notify-stall demotion and the dead-client respawn now retire a client through one `retireClient`, which also drops the per-write latency estimate (and, on the three paths that kept it, the notify backlog count) that a replacement used to inherit as a longer wedge window. The sweep's pre-open pass counts an auxiliary write only when `notify.open` did not report it refused. A new test fails if a `clients.delete` appears outside `retireClient`.
