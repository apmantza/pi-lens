---
section: Fixed
---

- **Make the /lens-perf occupancy guard deterministic (closes #2886)** — Count the parser's event-loop yields instead of measuring a wall-clock block the scheduler can inflate.
