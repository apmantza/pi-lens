---
section: Changed
audience: internal
---

- **Make the knip unused-code check a CI gate (refs #2837)** — the workflow job is now named `knip` with no `(advisory)` suffix, matching the hard `knip` preflight gate, so an unused export or file can no longer merge and red master.
