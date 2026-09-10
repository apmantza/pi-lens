---
section: Fixed
---
- **Make the runner spawn-cwd sweep verify resolver origin across the child-spawn population (refs #2872).** Bindings resolve by the grammar's own scope rather than a list of node kinds, and each admitted site is keyed by its cwd expression, so a laundered or edited cwd cannot inherit an admission.
