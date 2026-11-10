---
section: Fixed
audience: internal
---

- **The scanner witness waits for marker content, not existence.**
  A produced marker can exist briefly before its content lands; an
  existence-only settle can read an empty marker and fail the witness's
  first assertion. Scanner and tool-abort witnesses now wait for nonempty
  marker content.
  (refs #5105)
