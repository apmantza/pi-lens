---
section: Changed
audience: internal
---

- `scripts/ci-verdict.mjs` prints one advisory `MUTATION` line for a PR: the `Mutation diff` comment's survivor count and the head it covers, `STALE` when that is not the PR head, `PENDING` when there is no comment and the job is still running, `no report (job <conclusion>)` when the job finished without one. It never changes an exit code, is read once per report within the `--wait` budget, and `--watch-open` never reads it. The fixer and reviewer contracts now scope hand mutation to the PR's new guards and have the reviewer triage the comment's survivors instead of re-running the table (closes #3779).
