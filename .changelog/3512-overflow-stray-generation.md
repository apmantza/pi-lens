---
section: Fixed
---

- A cascade finding from the previous session is no longer delivered after
  `/new`, a fork or a resume in the same project on three remaining paths. A
  file analysis from the old session that was still running when the new
  session started could hand its cascade to the new session. A cascade result
  that finished after the new session started could reach it when more than 32
  results were pending at once. A cascade still running from the old session
  could also leave a neighbour check that the new session's quiet window then
  answered. All three are now tied to the session the analysis started in and
  dropped once that session is replaced, and each drop is recorded in the
  degradation ledger (`generation-guard-stale-write`) (closes #3512).
