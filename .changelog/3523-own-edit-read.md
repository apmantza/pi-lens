---
section: Fixed
audience: user
---

- **Re-editing a line the agent just wrote with a positional edit is no longer refused (refs #3523)** — after an allowed line-range edit (`edits[].range`), the read guard kept judging those lines against the read taken before the edit, so the agent's next edit of the same lines was refused as "Edit range changed since read". A single-range edit that the guard allowed at the agent's own line numbers is now recorded as the agent's read of the lines it wrote, hashed from its `newText`; a change another writer makes to those lines afterwards is still refused. An edit the guard relocated, and a multi-range batch, are not recorded, because their written lines are not where the agent's numbers say.
