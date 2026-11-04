---
section: Changed
audience: internal
---

- CI runs less often and opens fewer PRs. CodeQL scans once a day (and on dispatch) instead of on every master push and every pull request, so a new alert surfaces on master up to a day after its change; Dependabot groups minor and patch bumps per dependency type, security updates, and GitHub Actions bumps. (refs #5275)
