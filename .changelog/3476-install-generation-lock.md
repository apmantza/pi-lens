---
section: Fixed
---

- The shared tools install lock no longer lets two sessions install at once
  after a third died holding it. Taking over a stale lock removed it by path,
  so a taker acting on an earlier judgement could remove the lock a second
  taker had just created. The lock is now a generation lock in
  `tools/.install.locks/`: every acquisition creates the next generation
  exclusively, so exactly one taker wins. Releasing the lock, or exiting while
  holding it, no longer removes a lock another holder took over after an
  age-out. A holder also takes the old `tools/.install.lock` file, so
  installers from older versions still block (refs #3476).
