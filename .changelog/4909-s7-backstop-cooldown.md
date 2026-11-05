---
section: Fixed
audience: internal
---

- Tier-2 pi sessions start with the orphan-backstop cooldown armed, so a long test file's 30 s sweep cannot SIGKILL a stale host process and red the #2042 kill guard (refs #4909).
