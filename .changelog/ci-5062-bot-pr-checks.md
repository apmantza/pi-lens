---
section: Fixed
audience: internal
---

- **Nightly refresh PRs start the required CI**: the job that opens the LSP-docs refresh and idle-eviction promotion PRs now dispatches `ci.yml` and `lint.yml` on the bot branch, because a PR opened with `GITHUB_TOKEN` starts no `pull_request` run and sat BLOCKED with every check absent, and `ci-verdict` now gates the non-advisory checks of a dispatch run on a bot-opened PR like a `pull_request` run (#5062).
