---
section: Fixed
---

- turn_end now selects and runs tests for an edit in a linked worktree of the session's repository in that worktree's own root, with its own config and `node_modules` (no more zero turn-end tests when the session cwd is the main checkout); a worktree failure is located relative to the session checkout, a worktree without its own runner install is skipped and counted as `turn-end-test-root-skipped` instead of fetching through `npx`, independent clones and submodules stay excluded, and `test-target-foreign-checkout` rows now carry `sameCommonDir` (#3871)
