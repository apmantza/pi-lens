---
section: Fixed
audience: internal
---

- Make `scripts/ci-verdict.mjs` print green for a PR only when the PR's own `statusCheckRollup` (the view GitHub's merge gate reads) also carries a concluded success for every required name: a PR whose required rows came from `workflow_dispatch` runs alone, as #5623's did, reads pending with the close/reopen advice instead of exit 0 over a BLOCKED merge, and an unreadable rollup is pending, never green. (refs #5629)
