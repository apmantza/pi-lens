---
section: Fixed
---

- The durable-store lock (dispositions and actionable warnings) no longer lets
  two sessions commit at once after a third died holding it. Taking over a
  stale lock unlinked it by path, so a taker acting on an earlier judgement
  could unlink the lock a second taker had just created. The lock is now a
  generation lock in `<store>.locks/`: every acquisition creates the next
  generation exclusively, so exactly one taker wins. A holder also takes the
  old `<store>.lock` file, so writers from older versions still block. That
  file is judged by pid liveness alone, so a live holder is still never
  superseded, and a recycled pid still holds the lock until that process
  exits (refs #3476).
