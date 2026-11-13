---
section: Fixed
audience: internal
---

- **Generation-ledger stamp tests no longer follow the temp path length.** Five cells in three test files matched the end of a record whose text the ledger bounds at 200 characters, so a long `TMPDIR` cut the tail and reddened them. They now select each record by the bounded rendering of the identity its producer writes, and one cell pins the stamp's size component where it decides behaviour: the resolver's verdict memo. (refs #5575, #5576)
