---
section: Changed
audience: internal
---

- The three required `Install test (<os>)` legs now install only when a pull request touches `INSTALL_PATHS` (`scripts/ci-changed-files.mjs`: the manifests, the lifecycle scripts, the scripts the job runs, `bin/`, the two install workflows) and otherwise pass in seconds with "no install files changed"; `Strict install (cold npm cache)`, the lint `strictness` job and the install-smoke `smoke` job (outside install paths) no longer start on a pull request, the `greeting` job starts only for a first-time author, and master pushes, the merge queue and dispatches keep every step (#5112).
