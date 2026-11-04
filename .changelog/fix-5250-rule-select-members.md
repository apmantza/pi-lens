---
section: Fixed
audience: user
---

- **A non-string entry in `rules.<id>.select` no longer throws in the rule filter.** `select` now drops a non-string member, or a value that is not an array, the same way `disable` does, and the valid entries keep their effect. A global config reports it with a `PILENS_CFG_0005` notice; a project or nested file's is dropped without one (#5250).
