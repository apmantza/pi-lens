---
section: Changed
---

- `scripts/ci-verdict.mjs --wait` now also waits out a transient GitHub
  failure while it looks up the repository and the PR's head commit, so a wait
  started during a GitHub outage waits instead of exiting 70 at once. Startup
  retries and the check-runs poll share the one `--wait` budget (refs #2935).
