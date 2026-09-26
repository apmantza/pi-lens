---
section: Fixed
---

- A language server respawned after a crash, or back from a notify-stall
  demotion, is no longer treated as warm, or as known cold, because its
  predecessor was. Every client retirement now forgets both verdicts, and a
  touch whose client was replaced while it waited no longer marks the
  replacement ready, so the workspace sweep warms the new server up instead
  of timing out on its first files or skipping them (closes #3502).
