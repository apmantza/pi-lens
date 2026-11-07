---
section: Fixed
audience: user
area: tools
---

- **The performance report no longer ranks waiting time as slow work.** Phases that record how long ago something happened, such as a document drift age or the time since process start, now write that value as `ageMs` and are left out of the slowest-phase ranking, including in older logs. (refs #5379)
