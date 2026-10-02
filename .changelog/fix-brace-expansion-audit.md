---
section: Fixed
audience: user
---

- **The production dependency audit passes again: brace-expansion is updated to 5.0.12 (closes #3659)** — `brace-expansion` 4.0.0 to 5.0.11 (pulled in by `minimatch`) carries three advisories (GHSA-q2hr-2g5m-vwhr, GHSA-qhr7-859c-m2p7, GHSA-6j4f-fj2g-mc7p), one rated high, which turned the `Audit production dependencies` step of `Lint & type-check` red on every PR. Only the lockfile entry changed; the `minimatch` range already allowed the patched version.
