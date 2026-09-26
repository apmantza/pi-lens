---
section: Fixed
---

- **One edit no longer runs its analysis twice when pi-lens is still starting up (closes #3508)** — after a slow first start, the analysis of an edited file waited for pi-lens' linters and formatters to finish loading only after it had claimed the file's new contents. Two notifications for the same contents could then both claim them and both run the analysis, including two autofix passes on one file. The wait now comes first, as it already did for edits pi-lens only observes, so the second notification joins the running analysis.
