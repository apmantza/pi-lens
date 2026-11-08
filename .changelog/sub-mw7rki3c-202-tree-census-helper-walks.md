---
section: Fixed
audience: internal
---

- **The tree-walk census now follows helper modules.** A test that pays a whole-tree walk inside an imported `tests/` helper kept vitest's 5 s default and timed out on the Windows unit leg. The census now derives each helper module's verdicts from its source, fails an unresolvable call closed as a walk, and budgets 157 members it could not see before (#4967).
