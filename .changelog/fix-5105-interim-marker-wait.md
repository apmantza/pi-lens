---
section: Fixed
audience: internal
---

- **Test witnesses wait for marker content, not existence.**
  An empty marker can release a waiter that reads a report path or PID
  from it. The scanner, tool-abort and madge witnesses, and the mutate
  and outside-root waits, now wait for nonempty marker content.
  (refs #5105)
