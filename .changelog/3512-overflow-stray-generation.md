---
section: Fixed
---

- A cascade finding from the previous session is no longer delivered after
  `/new`, a fork or a resume in the same project on two remaining paths. A
  cascade result that finished after the new session started could still reach
  it when more than 32 results were pending at once. A cascade still running
  from the old session could also leave a neighbour check that the new
  session's quiet window then answered. Both are now tied to the session that
  started them and dropped once that session is replaced, and each drop is
  recorded in the degradation ledger (`generation-guard-stale-write`)
  (closes #3512).
