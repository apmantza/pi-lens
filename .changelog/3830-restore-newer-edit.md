---
section: Fixed
---

- A whole-package fixer's restore (`cargo clippy --fix`, `dart fix --apply`) no longer overwrites an agent edit of a sibling file that lands while it writes: it runs under pi's queue for that file, stays registered until it ends, and compares bytes before writing.
