---
section: Fixed
audience: user
---

- Give the review graph a per-run private fact store for its per-file extraction, so a concurrent dispatch for the same file can no longer make the graph extract imports and functions from two different versions, and the graph no longer writes or deletes the dispatch's `file.content` and derived facts (closes #3552).
