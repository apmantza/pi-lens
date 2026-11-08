---
section: Fixed
audience: internal
---

- **The tree-walk census now follows helper modules.** A test that pays a whole-tree walk inside an imported `tests/` helper kept vitest's 5 s default and timed out on the Windows unit leg. The census now derives each helper module's verdicts from its source, fails an unresolvable call closed as a walk, and reads the `it(title, { timeout }, fn)` form; on one tree it counts 399 members where it counted 259, all budgeted (#4967).
