---
section: Fixed
audience: user
---

- **A process serving several live sessions releases its registry entry and stale primary registration** — One pi-lens activation can serve more than one live session: pi re-runs the extension factory per session, but a host can also deliver several `session_start` events to a single activation, where the first session is `primary` and each later one is a declined `concurrent-secondary`. The activation recorded only the LAST classification it saw, so a secondary's start overwrote the primary's role and every later shutdown, the primary's included, took the local-only branch. `cancelLSPIdleReset`, `resetLSPService`, `deregisterInstance` and the primary registration release therefore never ran for the process, which kept its `instances.json` entry and its stale primary registration until it exited. The shared teardown now belongs to the last live session of an activation, whatever each session was classified as, and a non-last leave ends only that session's own bookkeeping (#4554).
