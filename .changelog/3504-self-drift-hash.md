---
section: Fixed
---

- **A same-size rewrite of a file under a tree-sitter or ast-grep blocker now demotes the blocker (closes #3504)** — the turn-end check skipped the content comparison for these blockers whenever the file's size matched and its modification time had not moved past the verdict, so a one-character edit that kept the length, landing close to the verdict or behind a coarse timestamp, left the old blocker, security rules included, authoritative. The check now compares the file's content with the analysed bytes whenever it has them, as it already did for language-server blockers.
