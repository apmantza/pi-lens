---
section: Fixed
audience: internal
---

- `tests/support/pi-session-commit-gate.ts` now owns one `warmGuardedSession` warm-up that pays a guarded session's cold first-session cost in a `beforeAll`, so `tests/index-4689-path-identity-witness.test.ts` no longer times out on its first case under `--sequence.seed=424`; `tests/index-4632-s4-tool-call-verdict.test.ts` calls it instead of carrying its own copy (closes #5061, refs #5023 #4909).
