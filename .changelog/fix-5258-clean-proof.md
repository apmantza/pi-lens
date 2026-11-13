---
section: Fixed
audience: user
area: tools
---

- **pi-lens no longer calls a file clean when its check did not finish.**
  The `lens_diagnostics` header and its check line say "unconfirmed" when a
  full sweep stopped early, an analyzer failed, ran partly or was stopped,
  a file changed after its last check or still has a check pending, or a
  shown finding is stale. Delta mode reports "no new findings" instead of
  "clean". Knip exiting with no report is named as unread, not "No issues
  found". A warning re-check keeps each warning whose code-action lookup
  never answered, and still retires the ones it confirmed fixed. (refs #5258)
