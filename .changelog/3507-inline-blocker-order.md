---
section: Fixed
---

- **A slower, older analysis of a file no longer erases or replaces the newer edit's blocker (closes #3507)** — pi runs tool calls in parallel, so the analyses of two edits to one file can overlap. Whichever finished last used to decide the file's entry in the turn-end "Unresolved from this turn" list and the commit gate: an older clean result erased the newer edit's blocker and unlatched the gate, and an older blocker replaced the newer verdict. Recording and clearing that entry are now ordered by the edit they came from, across turns as well, and a result that arrives after a newer one changes neither the entry nor the commit gate.
