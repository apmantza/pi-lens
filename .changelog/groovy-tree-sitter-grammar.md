---
section: Added
audience: user
area: tools
---

- **`module_report` and `read_symbol` now list Groovy classes and methods.** Symbol search, imports and read expansion work for them too, and traits, interfaces, enums and constructors are listed. `.groovy`, `.gvy`, `.gy` and `.gsh` files, plus `Jenkinsfile`, `build.gradle` and `settings.gradle`, parse with a vendored tree-sitter grammar. The grammar is partial: 70% of 1,353 real files parse with no error node. Types nested in a class, command calls with named arguments and the diamond `<>` do not parse, and `module_report` shows its syntax-error warning on a partial parse. Lint and format for Groovy are not part of this change. (refs #5235)
