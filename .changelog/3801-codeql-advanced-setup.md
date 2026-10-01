---
section: Changed
---

- **CodeQL moves from GitHub default setup to a committed advanced setup with advisory PR analysis (refs #3801)** — PR-time CodeQL for `actions` and `javascript-typescript` is now an advisory `CodeQL (<language>) (advisory)` job in `ci.yml` that starts only after lint, unit tests, install test and TLA+ models all succeeded on the head, so a red required check no longer also occupies two CodeQL runners. A new `codeql.yml` covers master pushes and a weekly re-scan, with SHA-pinned `github/codeql-action` steps, `build-mode: none` and `cases`, `tests/fixtures` and `dist` excluded. `ci-verdict` and the merge train classify the new job names as advisory through the `(advisory)` suffix, and keep gating on the legacy default-setup `Analyze (<language>)` rows an older head may still carry.
