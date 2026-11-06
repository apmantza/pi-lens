---
section: Fixed
audience: user
area: rules
---

- **`.mts` and `.cts` files now get the same checks as `.ts`.** Twelve fact rules (`error-swallowing`, `cors-wildcard`, `no-commented-credentials`, `placeholder-comments` and eight more), the comment and try/catch fact providers, the JS/TS autofix and linter policy, and the project scan each left out `.mts` and `.cts`, so those files read as unchecked with no notice. They now share one TypeScript-family check. (refs #4907)
