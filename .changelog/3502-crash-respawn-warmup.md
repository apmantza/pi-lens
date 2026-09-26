---
section: Fixed
---

- A language server respawned after a crash is no longer treated as warm
  because its dead predecessor was. Like a capacity or idle eviction, the
  respawn now forgets the old client's readiness and its cached cold verdict,
  so the workspace sweep warms the new server up instead of timing out on its
  first files, or skipping them as known cold (closes #3502).
