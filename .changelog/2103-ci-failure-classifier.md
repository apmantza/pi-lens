---
section: Added
---

- **CI failures now distinguish infrastructure outages from real test failures and arm one rerun** (refs #2103, #2784) — the classifier recognizes exit-137 kills, CodeQL/SARIF outages, codeload throttling, and npm CI timeouts, while preserving assertion and TypeScript failures as real. It updates one PR comment, applies the manifest-managed CI label, and lets the verdict report an armed infrastructure rerun as pending; **Terminal CI rerun finalization now covers master push and repository-dispatch runs** (refs #2103, #2784) — the workflow finalizes second-attempt classifications for every supported event and records a bounded step summary when no associated PR exists.
