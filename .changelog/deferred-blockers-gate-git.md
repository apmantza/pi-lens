---
section: Fixed
audience: user
---

- A collect-later runner's blocking finding now gates `git commit` and `git push` under `--lens-guard`, before and after the turn end that delivers it, until a later edit resolves it (#3814). A settled answer whose session has already been replaced no longer gates the next session's commit. The linked-worktree turn-end test now waits on the batch's own completion instead of a snapshot of the runner calls, so a turn whose edited worktrees exceed the batch concurrency is no longer raced by the CI observation (#3896).
