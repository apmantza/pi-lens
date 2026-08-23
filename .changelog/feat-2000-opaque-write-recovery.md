---
section: Added
---

- **Opaque-write recovery for bash commands (refs #2000 phase 2)** — commands the path extractor does not recognize (python/node/perl/PowerShell internal writes) now get a bounded pre/post stat diff of the project source universe. Recovered files are attributed to the read guard as agent-authored and dispatched through the mutation seam, with explicit coverage-unknown telemetry instead of silent gaps.
