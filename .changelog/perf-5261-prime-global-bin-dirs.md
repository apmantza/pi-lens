---
section: Fixed
audience: user
area: install
---

- **The first edit of a session no longer waits on an `npm config get prefix` spawn.** The lookup of the package managers' global bin dirs now starts at session start, so the first dispatch joins it instead of paying about 0.3 s for `which npm` and `npm config get prefix`. `session_start` itself costs no more than before. A tool process that exits before its first resource sample no longer records a false `resource-sampler-query-failed` record. (refs #5261)
