---
section: Fixed
audience: internal
---

- `tests/clients/runtime-tool-result.test.ts` warms the first-touch pre-edit capture in a `beforeAll`, so the decorated-bash `structuredContent` case no longer pays its one-time tree-sitter and dispatch load inside its own 5 s budget. The case timed out at 5 s on Windows; on the Windows CI job (run 45935233393) its two variants now take 2.3 s and 1.9 s. (refs #5798)
