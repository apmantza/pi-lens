---
section: Fixed
audience: user
---

- **A nearer config no longer re-enables rules you disabled.** `rules.<id>.disable` is now the union of the global, project and nested `.pi-lens.json` lists, so a project or `pkg/.pi-lens.json` that lists one rule keeps the rules the global or root config disabled. A non-string entry in the list is dropped instead of throwing in the rule filter. A global config reports it with a config notice; a project or nested `.pi-lens.json` drops it silently unless the list has no usable string left (#5232).
