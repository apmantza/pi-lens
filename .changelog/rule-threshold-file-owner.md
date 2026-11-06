---
section: Fixed
audience: user
---

- **A nested package's `rules.<id>.threshold` now applies to its own files.** `rules.high-complexity.threshold` and `rules.high-fan-out.threshold` follow the edited file's nearest `.pi-lens.json`, field by field, like `rules.<id>.disable`: with `40` at the workspace root and `5` in `pkg/.pi-lens.json`, a function in `pkg/` is judged by `5`, and a file at the root still by `40` (fixes #5292).
