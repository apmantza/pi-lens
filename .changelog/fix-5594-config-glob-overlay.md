---
section: Fixed
audience: user
area: runners
---

- **detekt, phpstan and credo no longer read a project under a `.claude/worktrees` checkout as clean.** A project config that ignores `**/.claude/**` matched the checkout's own ancestors, so the tool saw no file and the runner reported none. The runner now hands the tool a generated copy of the config with each ignore glob anchored at the project root, keeps the project's own ignore list, and reports an ignore it cannot anchor as inconclusive. (refs #5594)
