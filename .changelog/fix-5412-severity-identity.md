---
section: Fixed
audience: user
area: runners
---

- **Information-level findings now count as advisory warnings on every path.** Pyright information findings were warnings through the CLI and `none` through the language server, so the copy the dispatcher kept depended on which lane answered. A finding with no rule also took its identity from its line alone, so a second finding on the same line could drop out of the report. (refs #5412)
