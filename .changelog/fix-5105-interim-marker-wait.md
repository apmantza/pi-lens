---
section: Fixed
audience: internal
---

- **The scanner witness waits for marker content, not existence.**
  An empty marker can release a waiter that reads a report path or PID
  from it. The scanner and tool-abort witnesses, and the madge abort
  witness, now wait for nonempty marker content.
  (refs #5105)
