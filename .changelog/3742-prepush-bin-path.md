---
section: Fixed
audience: internal
---

- The real-pi test harness no longer depends on the caller's PATH. It puts
  the repo's `node_modules/.bin` and the running node's directory first on
  the pi child's PATH, as `npm run` does, so
  `tests/real-harness/diagnostic-provenance.test.ts` gives the same verdict
  under the pre-push hook, a bare `vitest`, and `npm run` (closes #3742).
