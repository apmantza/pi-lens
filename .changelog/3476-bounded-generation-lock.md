---
section: Fixed
---

- The durable-store lock (dispositions and actionable warnings) no longer lets
  two sessions commit at once after a third died holding it. Taking over a
  stale lock unlinked it by path, so a taker acting on an earlier judgement
  could unlink the lock a second taker had just created. The lock is now a
  generation lock in `<store>.locks/`: every acquisition creates the next
  generation exclusively, so exactly one taker wins. A holder also takes the
  old `<store>.lock` file, so writers from older versions still block, and a
  live holder is now superseded after 5 s (refs #3476).
