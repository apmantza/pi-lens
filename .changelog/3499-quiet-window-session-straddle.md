---
section: Fixed
---

- A cascade finding from the previous session is no longer delivered after
  `/new`, a fork or a resume in the same project. The quiet window that runs
  after an agent run could still be settling cascade results when the new
  session started. It then put the old session's run into the new session,
  whose first turn delivered it. That window now drops its late cascade writes
  once its session has been replaced, and records each drop in the degradation
  ledger (`generation-guard-stale-write`) (closes #3499).
