---
section: Changed
audience: internal
---

- The `tool_result` handler learns which files a call wrote from the mutation bridge's per-call written set (`RuntimeCoordinator.takeCallWrites`) instead of a `details.appliedFiles` list admitted by tool name; the pre-edit seed takes its "before" bytes from one supplier per route, and the WRITERS table gains a `deferred-queue` column and the staged-delta gate cells. (refs #5551)
