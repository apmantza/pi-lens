---
section: Fixed
audience: user
area: host
---

- **Reloading the extension no longer slows every async operation a little more.** The spawn cancellation and cooldown scopes are now one per process instead of one per reload, so a long session that reloads pi-lens stays as fast as a fresh one. (refs #5182, #5413)
