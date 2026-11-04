---
section: Changed
audience: internal
---

- The cascade's changed-symbol references calls stay serial (refs #5174). Overlapping them was measured on tsserver and dropped answers under one shared 750 ms window, so the loop keeps one call at a time and a test pins that all three symbols come back.
