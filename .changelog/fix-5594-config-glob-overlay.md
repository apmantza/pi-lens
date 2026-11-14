---
section: Fixed
audience: user
area: runners
---

- **detekt, phpstan and credo no longer read a project under a `.claude/worktrees` checkout as clean.** A project config that ignores `**/.claude/**` matched the checkout's own ancestors, so the tool saw no file and the runner reported none. The runner now gives the tool the project's own config plus a generated overlay in which each ignore entry is anchored at the project root, with the same meaning it had in any other checkout. An entry whose meaning it cannot keep runs as written, and a clean result from that run is reported as inconclusive. (refs #5594)
