---
section: Fixed
---

- **A dependency or file edited while its analysis was still running now demotes the finding (closes #3503)** — pi runs tool calls in parallel, so another call can edit a file, or a file it imports, while pi-lens is still analysing an earlier edit. The turn-end blocker list and the diagnostics widget timed their verdict from when the analysis finished, so that edit looked older than the verdict and the stale blocker stayed authoritative for the rest of the session. They now time it from when the analysed bytes were read, after pi-lens' own formatting and autofix, so the edit demotes the finding at turn end.
