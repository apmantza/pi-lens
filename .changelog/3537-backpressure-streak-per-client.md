---
section: Fixed
audience: user
---

- **A restarted language server no longer inherits its predecessor's write timeouts (closes #3537)** — pi-lens disables a server for a cooldown after three write timeouts in a row. That count was kept per server rather than per running server process, so a server restarted after a crash, or re-spawned after an eviction, started with its predecessor's timeouts. It could then be disabled on its first slow write, for example while it was still starting, and lose diagnostics for the cooldown. The count now starts at zero for each new server process, and a predecessor's write that times out after the replacement started no longer counts against it.
