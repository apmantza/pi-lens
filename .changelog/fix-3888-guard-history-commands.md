---
section: Fixed
---

- **Guard force-push and rebase slips (closes #3888)** — the Bash hook now
  requires an explicitly authorized expected SHA for force-with-lease and
  directs workers to merge `origin/master` instead of rebasing.
