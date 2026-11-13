---
section: Fixed
audience: internal
---

- **Generation-ledger stamp tests no longer follow the temp path length.** Two `runner-helpers` cells matched the end of a record whose text the ledger bounds at 200 characters, so a long `TMPDIR` cut the stamp tail and reddened them. They now compare the record against the guarded write's own identity, and pin the stamp's size component where it decides behaviour: the resolver's verdict memo.
