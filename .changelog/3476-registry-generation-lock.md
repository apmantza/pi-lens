---
section: Fixed
---

- The instance registry lock no longer lets two sessions write the registry
  at once after a third died holding the lock. Taking over a stale lock
  removed it by path, so two takers could each remove what the other had just
  created. The lock is now a directory of numbered generations
  (`instances.json.locks/`): every acquisition creates the next one
  exclusively, so exactly one taker wins. While older versions run beside
  this one, a holder also takes the old `instances.json.lock` file, so the
  two versions still exclude each other (refs #3476).
