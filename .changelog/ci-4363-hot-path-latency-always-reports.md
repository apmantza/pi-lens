---
section: Changed
audience: internal
---

- `Hot-path latency (advisory)` now starts on every pull request and passes with "no hot-path files changed" when the diff touches none of `HOT_PATH_PATHS` (`scripts/ci-changed-files.mjs`), so it can become a required check without leaving docs-only pull requests at "Expected"; a hot-path diff still runs the full timing job, and a master push keeps its `paths:` filter (#4363).
