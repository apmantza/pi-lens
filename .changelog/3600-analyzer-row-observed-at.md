---
section: Fixed
audience: user
---

- **`lens_diagnostics mode=full` no longer re-stamps folded project rows at scan time (closes #3600)** — heavyweight-analyzer findings (knip, jscpd, madge, gitleaks, govulncheck, opengrep, trivy, dead-code, test-runner) and `projectDelta` rows were stamped by the #1888 correlated commit with the cheap project scan's `scannedAt`, or with the fold's own time when no scan ran. A file edited while the analyzer was still reading therefore looked older than its row, and no widget freshness gate demoted it. Every heavyweight client now stamps its own read time at the top of its run body, so a lane that joins another caller's in-flight run reports the initiator's read rather than its own later start; test-runner carries the batch's launch stamp; and each `projectDelta` row carries its own `observedAt` or the report's `generatedAt` through to the widget. An unparseable `generatedAt` is now recorded rather than silently widened to the fold clock.
