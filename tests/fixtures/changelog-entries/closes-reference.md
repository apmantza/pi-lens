---
section: Fixed
audience: user
area: host
---

- **A partial edit apply now reaches other extensions' pre-write guards.** When some edits of a batch matched and others did not, an extension loaded after pi-lens never saw those bytes. (closes #5120)
