---
section: Fixed
audience: user
area: host
---

- **The deferred-tools log field now reads the flag supported pi builds ship.** The `tool_set_mutation` row in `latency.log` reported the deferral capability as false on every supported pi host, because it read a compat flag only the long-unsupported pi 0.80.10 build shipped; it reads `compat.supportsToolSearch` now, so the row states the host's own decision. (refs #5361)
