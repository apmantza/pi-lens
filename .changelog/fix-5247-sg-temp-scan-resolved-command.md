---
section: Fixed
audience: user
---

- **Structural `ast_grep_replace` rules now work when your project has no `@ast-grep/cli` (closes #5247)** — a replace using `insideKind`, `hasKind`, `hasDescendantKind`, `follows` or `precedes` failed with `npm ERR! canceled` or `unexpected argument '--no'` because its rule scan ignored the ast-grep binary pi-lens had already found or installed. The scan now runs that binary.
