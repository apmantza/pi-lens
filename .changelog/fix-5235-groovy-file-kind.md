---
section: Added
audience: user
---

- **Groovy is a file kind (refs #5235)** — `.groovy`, `.gvy`, `.gy` and `.gsh` files, plus `Jenkinsfile`, `build.gradle` and `settings.gradle`, now classify as `groovy`, and the four extensions are selected by `lang:groovy` in `symbol_search`. The `symbol_search` `lang:` filters also accept named files (the three Groovy names, `Dockerfile`, `Makefile`), and the index collects them (#5273). The four extensions announce `groovy` to the language server; the three names have no built-in server, so writing them prints no "analysis unavailable" warning (the language-server lane reports not applicable for any file no server selects). On an adopted analysis root, a write to a file whose every planned runner the root refuses now reads "not analyzed" instead of "clean" (every kind, not only Groovy). Linting, formatting and structure for Groovy are separate slices of #5235.
