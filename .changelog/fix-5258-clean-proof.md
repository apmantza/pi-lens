---
section: Fixed
audience: user
area: tools
---

- **A clean report from pi-lens now needs proof that every file was checked.**
  The `lens_diagnostics` header and its check line say "unconfirmed" when a
  full sweep stopped early or a file was never checked, and the delta mode
  reports "no new findings" instead of "clean". Knip exiting with no report
  is named as unread, not "No issues found", and a warning re-check whose
  code-action lookup never answered keeps the warning as carried. (refs #5258)
