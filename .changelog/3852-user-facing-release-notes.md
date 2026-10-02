---
section: Changed
audience: internal
---

- **Release notes list user-facing changes only (closes #3852)** — every `.changelog/` fragment now declares `audience: user` or `audience: internal`; the GitHub release body lists the `user` entries and a one-line internal count, and `CHANGELOG.md` keeps the `internal` entries in a collapsed `### Internal` block per release.
