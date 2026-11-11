---
section: Changed
audience: internal
---

- **The cold-cache strict install now runs from its own workflow file.** `strict-install.yml` triggers on a master push and a manual dispatch only, so a pull request no longer shows a skipped `Strict install` row; the merge queue and the bot-PR dispatch no longer run it. (refs #5002)
