---
section: Fixed
audience: user
---

- **`.mts` and `.cts` files get the same checks as `.ts` (refs #4907)** — twelve fact rules (`error-swallowing`, `cors-wildcard`, `no-commented-credentials`, `placeholder-comments` and eight more), the comment and try/catch fact providers, the JS/TS autofix and linter policy, and the project scan's fact rules each spelled the TypeScript family by hand and left out `.mts` and `.cts`, so those files read as unchecked with no notice. They now read one registry fact (`isTypeScriptFile`) or the JS/TS source family (`isJstsFactFile`).
