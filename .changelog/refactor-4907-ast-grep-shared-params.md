---
section: Changed
audience: internal
---

- Fold the ast-grep search and replace tools' shared parameters (language, strictness, five relational filters) onto one `astGrepSharedParams` factory; the registered schemas are byte-identical. (refs #4907)
