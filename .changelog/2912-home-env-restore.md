---
section: Fixed
---

- **Isolate registry consumers and restore probe-home state (refs #2912)** — prevent later tests from inheriting the #2992 probe registry and keep PID-scoped root assertions independent of worker history.
