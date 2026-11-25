---
section: Fixed
audience: user
area: blockers
---

- **A single-range adapter edit now clears a stale read record.** The edit check judges the range the adapter reported, so a formatter or external rewrite no longer blocks every later edit and a re-read repairs the state. (refs #5762)
