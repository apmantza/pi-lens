---
section: Fixed
---

- **Decline ktlint autofix when project agreement is unavailable (refs #3000)** — when pi-lens cannot establish agreement with a Gradle- or Spotless-managed CLI, including convention plugins in `buildSrc` or included builds, it leaves the file unchanged and records one bounded session notice. The Gradle convention-plugin ownership walk stops at 10,000 directory entries; an exceeded scan declines safely and records one `gradle-ktlint-scan-budget-exceeded` notice per session.
