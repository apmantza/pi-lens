---
section: Fixed
audience: internal
---

- The test-suite lock behind `npm test` and `npm run test:targeted` no longer
  lets two runs in after a holder died. Taking over a stale lock (or shared
  slot) removed it by path, so two waiters could each remove what the other had
  just created, and two full suites then ran at once. Only the winner of a
  takeover, an exclusive create of the next generation in
  `test-suite.lock.takeover/`, now removes a stale lock, after reading it again;
  a waiter that did not remove it keeps waiting under its timeout. The lock
  files themselves are unchanged, so older checkouts still see them
  (closes #3516).
