---
section: Fixed
audience: internal
---

- **`scripts/ci-verdict.mjs` no longer advises "push or merge master to re-arm" while the head's `ci.yml` run is already registered but only queued (refs #3861)** — the absent-required message fired on a head whose `ci.yml` run GitHub had accepted; the run exists and the queue is slow, so the re-arm advice was wrong. The verdict now reads the head's workflow runs once through the existing `actions/runs?head_sha=` seam and re-arms only on a positive no-run answer: a registered run reports its run id and age, and an unreadable lookup (`state: unknown`) never authorizes a re-arm. The same change folds the retired merge-train references (the `repository_dispatch` arms, `record-post-merge-validation`, `validate-merge-train-dispatch`) out of live source and tests, leaving `CHANGELOG.md`, `HISTORY.md`, `.changelog/`, and executable fixtures untouched (refs #3862).
