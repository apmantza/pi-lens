---
section: Fixed
audience: user
area: runners
---

- **A truncated gitleaks or trivy report now reports a failed scan, not a clean one.** A report the scanner could not read used to read as "no secrets or vulnerabilities found"; it now leaves a failed result and a `security-scan-report-failed` health row that names the unreadable report, as jscpd and opengrep already did. An empty report file still reads as an empty run. (refs #5447)
