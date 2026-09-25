---
section: Changed
---

- `scripts/ci-verdict.mjs --wait` now waits out a transient GitHub API
  failure on the check-runs read — a connect error, an HTTP 5xx, or a `gh` call
  that hit its own timeout — backing off from 30 s, doubling to 5 min, and
  printing one line per retry. It exits 70 only when the `--wait` budget runs
  out while GitHub is still unreachable. Auth and repo errors, and one-shot
  reads without `--wait`, still exit 70 at once (refs #2935).
