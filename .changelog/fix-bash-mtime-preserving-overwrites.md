---
section: Fixed
audience: user
area: host
---

- **Bash overwrites with preserved mtimes are recovered by content.** Recognized `mv`, `cp -p`, and similar writes now reach the normal dispatch path even when the destination keeps an old modification time. (refs #5552)
