---
section: Fixed
audience: internal
---

- The #3179 race test drops `-p` from its churner `mkdir`, so a late writer cannot recreate the temp root the test removed (#5527).
