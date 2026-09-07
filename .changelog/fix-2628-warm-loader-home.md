---
section: Fixed
---

- **The install-time warm-loader log now honors `PI_LENS_HOME` (closes #2628)** — agent-worktree installs no longer write `warm_loader_cache` records to the maintainer's real `~/.pi-lens/install.log` when the worktree home is pinned.
