---
section: Fixed
audience: user
---

- **`symbol_search` now indexes named files.** A `Jenkinsfile`, `build.gradle`, `settings.gradle`, `Dockerfile`, `Makefile`, `CMakeLists.txt` or `terragrunt.hcl` was never in the word index, because the source walk admitted files by extension only, so `lang:groovy` had nothing to return for a `Jenkinsfile`. The index build and its incremental refresh now keep these names after the usual ignore and generated-file checks. Review graph, project diagnostics, the language profile and the TODO baseline keep their extension-only walk. (#5273)
