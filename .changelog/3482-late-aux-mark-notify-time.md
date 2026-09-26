---
section: Fixed
---

- **Late-auxiliary coverage is marked at the touch's notify time (refs #3482)** — the turn-end drain compared a file's mtime against a baseline stamped after the aux-grace wait gave up, up to 2 s after the notify. A save inside that window looked unmodified, so a scanner's findings for the previous revision were delivered as current. The baseline is now the touch's own start time.
