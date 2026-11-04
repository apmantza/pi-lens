---
section: Fixed
audience: internal
---

- The nightly LSP-docs refresh PR and the idle-eviction promotion PR opened with bodies that had none of the PR template's sections (and a flips fence over the 20-line cap), so `PR body (advisory)` was red on every bot push; both composers now write the template sections with docs-only answers, and `tests/scripts/bot-refresh-pr-body-lint.test.ts` runs them through the real body lint. (refs #5062)
