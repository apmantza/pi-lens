---
section: Added
audience: user
---

- **`module_report` and `read_symbol` now list Groovy classes and methods.** Symbol search, imports and read expansion work for them too, and traits, interfaces, enums and constructors are listed. `.groovy`, `.gvy`, `.gy` and `.gsh` files, plus `Jenkinsfile`, `build.gradle` and `settings.gradle`, parse with a vendored tree-sitter grammar (dekobon/tree-sitter-groovy v0.3.0, unpatched). The grammar is partial: 70% of 1,353 real files parse with no ERROR node (`build.gradle` 95%, Jenkins pipelines 73%, `Jenkinsfile`-named files 50% of 4, Spock 64%, Grails 56%). Types nested in a class, command calls with named arguments (`mail to: x, subject: y`, `@Library('x') _`), a field with modifiers and no type, and the diamond `<>` do not parse, and `module_report` shows its syntax-error warning on a partial parse. Lint and format for Groovy are not part of this change (refs #5235).
