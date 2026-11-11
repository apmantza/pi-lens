---
section: Fixed
audience: user
area: security
---

- **A secret found by gitleaks and trivy now shows as one blocker row.** The turn-end report used to list the same line twice, once per scanner, because gitleaks cites an absolute path and trivy a path relative to its scan root. A secret only trivy finds now also drops its ast-grep copy from the fixable-warnings advisory. (refs #5459)
