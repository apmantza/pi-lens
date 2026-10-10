---
section: Changed
audience: user
---

- **Stale test-runner verdicts state their edit gap and re-queue a run.** When an async verdict is delivered for a file the agent has edited since the run started, the message names the file and how many edits behind it is and queues a re-run for the current version instead of presenting the old verdict as current.
