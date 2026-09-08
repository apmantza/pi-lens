---
section: Fixed
---

- **Call-site sweeps now share the AST-backed `sweep-kit.callSites` seam (refs #2694)** — runner cwd and real-process detectors no longer hand-roll balanced-parenthesis scans, so nested syntax, comments, and strings cannot change a call's boundaries.
