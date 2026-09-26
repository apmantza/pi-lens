---
section: Fixed
---

- The quarantine lock (the probe cache, the tool-refresh state and the orphan
  backstop sweep) no longer lets two sessions in at once after a third died
  holding it. A taker renamed the lock directory aside to inspect it, so while
  a live successor's lock was aside a fourth session could create the path and
  enter beside it. The lock is now a generation lock in `<store>.locks/`:
  every acquisition creates the next generation exclusively, so exactly one
  taker wins. A holder also takes the old `<store>.lock` directory, so writers
  from older versions still block (refs #3476).
