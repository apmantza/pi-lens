---
section: Fixed
audience: internal
---

- The #4530 trust suite and the #4760 auxiliary-root decline now compare the `degradation-ledger`'s bounded subject instead of the raw `kind:path` key, so a lane checkout with a long path no longer reddens them in the pre-push hook (refs #5246).
