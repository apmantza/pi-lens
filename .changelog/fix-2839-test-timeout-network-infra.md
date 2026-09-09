---
section: Fixed
---

- **CI failure classifier: a test timeout beside registry network failures is infra, not real (refs #2839)** — A Unit-tests job whose only test-level failure is a vitest `Test timed out in Nms` line (no `AssertionError`, no compiler diagnostic) now classifies `infra-net` when the log also carries registry-unreachable evidence (`npm error code ECONNRESET` through every `npm-retry` attempt, codeload/SARIF 429/503, `npm ci` ETIMEDOUT, `npm-retry: attempt N network error`), so the once-per-SHA automatic rerun arms instead of the job sitting `ci:real`; PRs #2834 and #2835 both hit this and were re-run by hand. An `AssertionError` or a TypeScript `error TS` line beside the same network noise still classifies `real`, and a lone timeout with no network evidence is unchanged.
