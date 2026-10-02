---
section: Changed
audience: internal
---

- Prepare the repository for GitHub's merge queue: `ci.yml` and `lint.yml` (every required check) now run on `merge_group`, `ci-verdict` reports a queued PR as `in-queue` (exit 3) and a failed queue run as a failure naming the failing job and test, the warden stops kicking `update-branch` for a queued PR or anywhere `master` has a queue, and `docs/merge-queue-rollout.md` gives the maintainer's ruleset settings. Nothing changes until the queue is enabled (refs #3754).
