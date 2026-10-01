---
section: Fixed
---

- After a `/tree`, `/fork`, `/new` or a resume, the actionable-warning quick fix no longer lets the new branch edit a file it never read: the fix is credited only with the read-guard epoch and lineage its report entries were built under.
