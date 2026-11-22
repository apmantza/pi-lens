---
section: Fixed
audience: user
area: config
---

- **A legacy `pi-lens.json` is now ignored everywhere once a `.pi-lens.json` exists.** Rule policy, per-folder `autofix` and `format` switches, nested `ignore` lists and `effective_config` used to keep reading the older file beside the new one, so a half-migrated project behaved differently by feature. A project with only the legacy file keeps working, and the language-server settings still read it until it is removed. (refs #5740)
