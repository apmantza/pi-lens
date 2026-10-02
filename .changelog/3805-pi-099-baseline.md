---
section: Changed
audience: internal
---

- **Move the dev and test baseline to pi 0.99.2 (refs #3805)** — The `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` devDependencies are now `^0.99.2`, the pi-host contract test pins pi's `_afterToolCall` event shape (`parentToolCallId`, `structuredContent`), and the fork/tree witness builds its tool context with pi's own `createToolContext`. The published supported-host window is unchanged: it is contiguous, so a ceiling past 0.86 would also claim 0.86 through 0.98, which no release-qa run has exercised.
