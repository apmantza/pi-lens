---
section: Fixed
audience: user
---

- **The read guard no longer lets a stale line through when a later read only context-covers it or the edit spans two reads (closes #3522)** — Each edited line is now checked against the newest read that actually showed it. Before, reading lines 5-8 after another writer changed line 4 cancelled the "range changed since read" block on line 4, and a two-line edit spanning two reads was never hash-checked. An edit is also relocated only from a read that is the newest view of every line of its range.
