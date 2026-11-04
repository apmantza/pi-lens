---
section: Fixed
audience: user
---

- **A non-string entry in `rules.<id>.select` no longer throws in the rule filter.** `select` now drops a non-string member, or a value that is not an array, the same way `disable` does, and the valid entries keep their effect. A global config reports each one with a `PILENS_CFG_0005` notice. A project or nested file reports a value that is not an array, or a list whose members are all dropped, with the same notice, and drops a non-string member beside a valid string without one (#5250).
