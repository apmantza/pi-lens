---
section: Fixed
audience: user
---

- **A partial edit apply now reaches other extensions' pre-write guards (closes #5120)** — When some edits of a batch matched and others did not, pi-lens wrote the matched edits itself from its `tool_call` handler, so an extension loaded after pi-lens never saw those bytes and could not refuse them. pi-lens now narrows the call's `edits` to the matched ones and lets pi's own edit tool write them, so every later `tool_call` handler sees exactly what will be written. The agent still gets the `⚠️ PARTIAL APPLY` message, now on the edit's own result. What changes for sessions with several extensions: a guard loaded after pi-lens is shown the narrowed batch, not the agent's full one, and can refuse it. A guard loaded before pi-lens still sees only the agent's batch, because pi does not re-run earlier handlers. The narrowed batch also goes through pi-lens's own read checks, so an edit to a file the agent never read is refused before anything is written. If the file changed after the check, pi's edit refuses the whole batch and the agent is told nothing was written.
