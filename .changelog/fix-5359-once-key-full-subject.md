---
section: Fixed
audience: user
area: tools
---

- **A second distinct warning is no longer dropped.** Two notices whose text shared their first 200 characters were treated as one event, so the second was never shown; a long checkout, fixture or `TMPDIR` path made that likely, and the shown notice stays the same length as before. (refs #5359)
