---
section: Fixed
audience: user
---

- **`symbol_search` `ext:` filters now match compound suffixes (closes #5136)** — an `ext:` value matches by path suffix, so `ext:test.ts`, `ext:.ts` and `-ext:test.ts` behave as a reader expects for `.test.ts`, `.spec.ts` and `.d.ts` files.
