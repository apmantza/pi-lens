---
section: Fixed
---

- **Parse pytest counts only from its terminal summary (closes #2408)** — Traceback and service-error numbers such as `port 55432 failed` can no longer become the reported failed-test count, and ANSI formatting no longer corrupts the first count.
