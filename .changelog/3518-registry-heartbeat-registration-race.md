---
section: Fixed
audience: user
---

- A heartbeat landing between session_start's registration and its own
  registry write no longer records a spurious missing-registration and
  re-registers redundantly. `updateHeartbeat` now runs on the same
  registry mutation queue as `registerInstance`/`registerInstanceRoot`/
  `deregisterInstance`, so a heartbeat queued behind a still-in-flight
  registration can no longer observe the registry before that
  registration's write lands (refs #3518).
