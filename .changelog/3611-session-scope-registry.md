---
section: Fixed
audience: user
---

- **Session scopes and the lineage handle (refs #3611)** — each pi session now gets a process-unique scope ticket, and write-order turns come from one process counter. A `/reload` that re-evaluates pi-lens no longer drops the live session's widget diagnostics as older, and two sessions' observed-mutation baselines can no longer be mistaken for each other. A `session_scope_transition` row in `latency.log` records every session start, shutdown and `/tree`, and a drain write dropped after its session ended is counted by retirement reason.
