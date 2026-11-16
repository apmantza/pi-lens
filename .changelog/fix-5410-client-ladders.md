---
section: Fixed
audience: user
area: runners
---

- **A project that ships its own jscpd is no longer reported as missing.** The duplicate-code, circular-dependency, unused-code and secret scans now check their binary the way the linters do, so a managed gitleaks or opengrep that fails its version check falls back to the one on PATH instead of triggering an install. (refs #5410)
