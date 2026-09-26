---
section: Fixed
---

- **The index integration suite stays under its per-worker memory budget (refs #3506)** — #3561's lazy host-SDK lookup loaded the real `@earendil-works/pi-coding-agent` package in `tests/index-integration.test.ts`, pushing its peak RSS over the #3058 2048 MB gate on CI. The file now stubs the package with a pass-through queue; the real queue stays covered by `tests/index-3506-file-mutation-queue-wiring.test.ts`.
