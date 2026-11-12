---
section: Added
audience: internal
---

- **A planted-home cell pins the #5399 `/lens-toggle` claim.** `tests/index-4913-cli-flag-timing.test.ts` plants the orphan-backstop stamp in the fixture home before its first `session_start`, in every case order, and a named cell asserts the post-toggle edit still records `dispatch_start` and `lsp_touch_file`. The claimed 4/4 cloud red did not reproduce on any host (routine, reviewers, the pi 1.5.0/Node 24 control, 20+ dev-host runs), so the pin turns the claim into an executable invariant. (refs #5399)
