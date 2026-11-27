---
section: Added
audience: internal
---

- `tests/config/vitest-lane-order.test.ts` now fails when a `*.test.ts` on the head is collected by no Vitest project (a test placed under `tests/fixtures/**` or another `sharedExclude` tree never ran and nothing went red), judged from Vitest's own resolver, with a reasoned allowlist for the one deliberate fixture. (refs #5805)
