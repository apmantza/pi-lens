---
section: Added
audience: internal
---

- **`npm run contributors:update` refreshes the all-contributors list (closes #3772)** — `scripts/update-contributors.mjs` reads merged-PR authors and issue reporters from `gh`, skips the owner and bots, and credits `code`, `doc`, `test`, `bug` and `ideas` through `all-contributors-cli`. `--dry-run` prints the planned changes with the PR and issue numbers behind them; a second run changes nothing.
