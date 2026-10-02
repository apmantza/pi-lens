---
section: Changed
audience: internal
---

- `ci-verdict` now does the CI reading the orchestrator did by hand: `--watch-open` watches every open PR that has auto-merge armed or is the maintainer's or `gh` viewer's and reports each PR's failed gating check, merge conflict, fork approval, long-absent required checks (also for a head with no check suite), merge or close on the transition from its last seen state (`--state-file` keeps it across re-arms), `--all` prints one state line per open PR, a failed gating job is read from its log (failed step, `FAIL` and assertion lines, `Tests` summary), advisory reds are listed apart from gating ones, a merge base that master has moved past gets a `gh pr update-branch` hint, a checkout that could not fetch `refs/pull/N/merge` after the PR merged is reported as post-merge noise rather than a failure, and `--wait` re-reads the auto-merge state and an unknown push time every poll.
