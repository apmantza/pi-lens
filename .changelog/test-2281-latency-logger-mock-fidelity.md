---
section: Fixed
---

- **Keep latency-logger test mocks faithful to production exports (closes #2281)** — latency-logger mocks preserve the real module surface, and a conformance sweep catches omitted exports.
