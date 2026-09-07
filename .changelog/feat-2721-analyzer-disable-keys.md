---
section: Added
---

- **Add per-analyzer `knip.enabled`, `jscpd.enabled`, `madge.enabled`, `gitleaks.enabled`, `govulncheck.enabled`, `deadCode.enabled`, and `complexity.enabled` keys plus `startup.mode` and `startup.scans.enabled` controls (refs #2721)** — project and global configuration can disable startup analyzers or heavyweight startup scans while preserving diagnostics and LSP.
