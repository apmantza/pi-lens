---
section: Fixed
---

- **Register only the read range the host delivered (refs #2802)** — Read-guard registration now uses the lines the host actually returned, including output-cap and EOF-clamped reads. A native read's provisional record is replaced by correlated tool-call identity rather than by position, so two reads of one file no longer leave the wider requested span behind and an unrelated search credit is never consumed. A delivered file that has disappeared no longer aborts the rest of the result chain, and an opaque write that leaves content identical no longer marks the file agent-authored. When bash observation evidence is unavailable, synthetic writes preserve authoritative content handling without granting read-guard authorship or edit permission.
