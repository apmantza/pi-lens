---
section: Fixed
audience: internal
---

- `tests/clients/runtime-tool-result.test.ts` warms the first-touch pre-edit capture in a `beforeAll`, so the decorated-bash `structuredContent` case no longer pays its one-time tree-sitter and dispatch load inside its own 5 s budget on a slow Windows runner. (refs #5798)
