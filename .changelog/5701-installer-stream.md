---
section: Fixed
audience: user
area: install
---

- **Installer downloads now stream through bounded temporary files.** Large release and rule-pack downloads no longer accumulate whole network bodies in memory, and stalled downloads are timed out with partial files removed. (refs #5701)
