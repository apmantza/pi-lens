---
section: Fixed
audience: user
---

- **A stuck sibling holding the change-log or snapshot cache lock costs one 500 ms wait, not one per edit (closes #3578)** — each logged edit and each snapshot save waited the full 500 ms afresh on a lock another process held, so ten logged edits under a stuck holder blocked the main thread for 5.0 s, and one snapshot save for 1.0 s (admission, then promotion). After a wait runs out, pi-lens now remembers that holder, named by its lock generation file. A later call that finds the same holder still inside tries once and falls back at once, as a timed-out wait does: the log entry is appended and tagged `unlocked`, or the snapshot write is skipped. In the PR's probe the ten edits took 0.51 s and the save 0.52-0.56 s. A new holder gets the full wait again, and a lock that was released, or whose holder died or ran past its lease, is still taken on the first try. The first skip on each lock is recorded once per session as `generation-lock-wait-skipped`.
