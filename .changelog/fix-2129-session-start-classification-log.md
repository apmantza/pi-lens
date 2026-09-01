---
section: Fixed
---

- **Log session-start classification alongside `mode` (closes #2129)** — `decideSessionStart` (#2133/#2156) already keeps a subagent temp worktree from stealing a process's primary session and re-running the full startup battery, but the classification decision it made was invisible on the accepted path: `session_start_total`, the record `mode` (quick/full) lives on, carried no root-identity input at all — only a declined start's `concurrent_session_bind` did. `handleSessionStart` now logs `classification` and `sameRoot` on `session_start_total` too, so a log reader can tell `primary` from `sequential-replacement` without cross-referencing a separate record.
