---
section: Fixed
---

- **Parse pytest counts only from its final summary (closes #2408)** — Traceback and service-error numbers such as `port 55432 failed` can no longer become the reported failed-test count.
