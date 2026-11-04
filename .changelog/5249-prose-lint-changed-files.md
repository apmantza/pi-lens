---
section: Changed
audience: internal
---

- The `Lint (advisory)` prose step runs Vale on the Markdown a pull request adds or changes under the prose paths, not on the whole docs tree every PR inherited. A PR with no such change skips the step with a notice, and an unreadable diff lints the whole list. Push and merge-queue runs keep the whole tree. Google.DateFormat is off in `.vale.ini`, since pi-lens docs write ISO dates on purpose. (refs #5249)
