---
section: Added
audience: user
---

- **Groovy is a file kind (refs #5235)** — `.groovy`, `.gvy`, `.gy` and `.gsh` files, plus `Jenkinsfile`, `build.gradle` and `settings.gradle`, now classify as `groovy`, announce `groovy` to the language server, and are selected by `lang:groovy` in `symbol_search` (inline filter and structured `lang`). The `lang:` filters also match other kinds' named files (`Dockerfile`, `Makefile`, `CMakeLists.txt`). Linting, formatting and structure for Groovy are separate slices of #5235.
