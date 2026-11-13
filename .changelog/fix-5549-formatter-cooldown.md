---
section: Fixed
audience: user
area: tools
---

- **Wedged formatters now stop retrying within a session.** A live formatter child is shared across concurrent writes, timeout cooldowns skip later writes, and only repeated deferred format failures are capped at one retry. (refs #5549)
