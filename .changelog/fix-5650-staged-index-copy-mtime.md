---
section: Fixed
audience: user
area: blockers
---

- **The commit gate now judges the staged bytes of a file rewritten as it was staged.** The gate reads a copy of the index, and the copy's new timestamp hid that git had not yet told such a file apart from its staged blob, so the gate linted the working bytes and could pass a commit that carried other bytes. The copy now keeps the index's timestamp. (refs #5650)
