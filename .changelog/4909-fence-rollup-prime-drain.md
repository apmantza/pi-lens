---
section: Fixed
audience: internal
---

- The fence-rollup cap case in `tests/index-3873-session-decision-records.test.ts` no longer reads a stray `package-manager-global-bin` write from the previous case's session_start global-bin-dir lookup: the file's `afterEach` now joins every registered background drain, so a loaded CI shard stops reading `guardedTotal: 21` for 20 writes. (refs #4909)
